
import { Command } from "@langchain/langgraph";
import { v4 as uuidv4 } from "uuid";
import { HumanMessage } from "@langchain/core/messages";

import { createGraph } from "@/agent/multi-agent/graph/root.graph_no_router";
import { SkillRegistry } from "@/agent/skills/registry";

import { createAcademicSkill } from "../skills/academic_new.skill";
import { createScheduleSkill } from "../skills/schedule_new.skill";
import { createCourseInfoSkill } from "../skills/course_info.skill";
import { createProgramSkill } from "../skills/program_new.skill";
import { createGradeLookupSkill } from "../skills/grade_lookup.skill";
import { createStudentInfoSkill } from "../skills/student_info.skill";
import { createTeacherTopicsSkill } from "../skills/teacher_topics_new.skill";
import { createCompanyTopicsSkill } from "../skills/company_topics_new.skill";
import { createPolicySearchSkill } from "@/agent/skills/policy-search.skill";
import { messageText } from "@/common/utils/llm-content";

import { TopicCacheService } from "../services/topic-cache.service";

import {
  LlmFactory,
  DEFAULT_LLM_REGISTRY,
} from "@/agent/llm/llm.factory";

import { createMongoSaver } from "@/agent/persistence/checkpointer";
import { HistoryStore } from "@/agent/persistence/history.store";

import { HustApiClient } from "@/agent/tools/clients/hust-api.client";
import { RedisClient } from "@/agent/tools/clients/redis.client";

import { createLogger } from "@/common/logger/logger";

// Middleware pipeline
import {
    AgentMiddleware,
    createMiddlewareContext,
    runMiddlewarePhase,
} from '@/agent/middleware/types';
import { contextInjectorMiddleware } from '@/agent/middleware/context-injector.middleware';
import { createStuckDetectorMiddleware } from '@/agent/middleware/stuck-detector.middleware';
import { piiRedactorMiddleware } from '@/agent/middleware/pii-redactor.middleware';

/* ───────── Tracing ───────── */
import { createTracingProvider } from "@/agent/tracing/index";

const logger = createLogger("MultiAgentFacade");

/* ──────────────────────────────────────────
 * Types (GIỮ NGUYÊN 100%)
 * ────────────────────────────────────────── */

export type AgentContext = {
  user_key: string;
  thread_id: string;
  request_id?: string;
  is_dual?: boolean;
};

export type AgentInput =
  | {
      kind: "message";
      message: { text: string };
      /** Ảnh đính kèm — multi-agent CHƯA hỗ trợ (state annotation riêng, không có
       *  kênh images). Nhận vào để đồng nhất kiểu với single-agent rồi bỏ qua. */
      images?: string[];
      options?: {
        trace?: boolean;
        locale?: "vi" | "en";
        tool_policy?: { allow?: string[]; deny?: string[] };
      };
    }
  | {
      kind: "resume";
      resume: { payload: unknown };
      options?: { trace?: boolean };
    };

export type FinalResult = {
  run_id: string;
  thread_id: string;
  request_id: string;
  status: "completed" | "error";
  assistant?: {
    text: string;
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    latency_ms: number;
    skills_used: string[];
  };
};

export type AgentEvent =
  | {
      type: "run.started";
      run_id: string;
      thread_id: string;
      ts: string;
      seq: number;
    }
  // 👇 THÊM ĐOẠN NÀY VÀO 👇
  | {
      type: "message.start";
      node?: string;
      seq: number;
    }
  // 👆 ------------------ 👆
  | {
      type: "message.delta";
      delta: string;
      node?: string;
      seq: number;
    }
  | {
      type: "run.completed";
      status: string;
      skills_used?: string[];
      seq: number;
    }
  | {
      type: "run.failed";
      error: {
        code: string;
        message: string;
      };
      seq: number;
    };

export interface AgentFacade {
  invoke(input: AgentInput, ctx: AgentContext): Promise<FinalResult>;
  stream(input: AgentInput, ctx: AgentContext): AsyncIterable<AgentEvent>;
}

/* ──────────────────────────────────────────
 * Factory
 * ────────────────────────────────────────── */

export function buildAgentFacade(deps: {
  mongoClient?: any;
  historyStore?: HistoryStore;
}): AgentFacade {
  /* ───────── Infra ───────── */
  const redis = new RedisClient();
  const hustApi = new HustApiClient();

  const topicCacheService = new TopicCacheService(redis, hustApi);

  /* ───────── LLM ───────── */
  const llmFactory = new LlmFactory(DEFAULT_LLM_REGISTRY);

  /* ───────── Skill Registry ───────── */
  const registry = new SkillRegistry();

  registry.register(createAcademicSkill(redis));
  registry.register(createScheduleSkill(redis));
  registry.register(createCourseInfoSkill(redis));
  registry.register(createProgramSkill(redis));
  registry.register(createGradeLookupSkill(redis));
  registry.register(createStudentInfoSkill(redis));

  registry.register(
    createTeacherTopicsSkill(
      redis,
      hustApi,
      topicCacheService,
    ),
  );

  registry.register(
    createCompanyTopicsSkill(
      redis,
      hustApi,
      topicCacheService,
    ),
  );

  registry.register(createPolicySearchSkill());

  /* ───────── Checkpointer ───────── */
  const checkpointer = deps.mongoClient
      ? createMongoSaver(deps.mongoClient)
      : undefined;

  /* ───────── Multi-Agent Graph ───────── */
  const graph = createGraph(
    checkpointer,
    deps.historyStore,
    registry,
    llmFactory,
    hustApi,
    redis,
  );

  /* ───────── Tracing ───────── */
  const tracingProvider = createTracingProvider();

  const middlewareStack: AgentMiddleware[] = [
      contextInjectorMiddleware,
      createStuckDetectorMiddleware({ maxToolFailures: 3, maxLoops: 5 }),
      piiRedactorMiddleware,
  ];

  /* ──────────────────────────────────────────
   * INVOKE (same output contract)
   * ────────────────────────────────────────── */

  return {
    async invoke(
      input: AgentInput,
      ctx: AgentContext,
    ): Promise<FinalResult> {
      const startMs = Date.now();
      const requestId = ctx.request_id ?? uuidv4();

      try {
        logger.info("invoke start", {
          thread: ctx.thread_id,
          user: ctx.user_key,
        });

        // 🛡️ 1. MIDDLEWARE: beforeAgent (Thiết lập ngữ cảnh và bảo mật)
        const mwCtx = createMiddlewareContext({
            user_key: ctx.user_key,
            thread_id: ctx.thread_id,
            request_id: requestId,
            tool_policy: (input as any).options?.tool_policy,
        });
        await runMiddlewarePhase(middlewareStack, 'beforeAgent', mwCtx);

        let finalState: any;

        /* ───────── Thread Config ───────── */
        const threadConfig: Record<string, any> = {
          configurable: {
            thread_id: ctx.thread_id,
            student_id: ctx.user_key,
            request_id: requestId,
            is_dual: ctx.is_dual,
          },
        };

        /* ───────── Tracing Callback ───────── */
        const tracingCb = tracingProvider.createCallbackHandler({
            threadId: ctx.thread_id,
            userId: ctx.user_key,
            requestId,
            input: {
              message: input.kind === "message" ? input.message.text : "[resume]",
              student_id: ctx.user_key,
            },
            tags: ["multi-agent", "invoke"],
        });

        if (tracingCb) {
          threadConfig.callbacks = [tracingCb];
        }

        /* ───────── Graph Invoke ───────── */
        if (input.kind === "message") {
          finalState = await graph.invoke(
            { messages: [new HumanMessage(input.message.text)] },
            threadConfig,
          );
        } else {
          finalState = await graph.invoke(
            new Command({ resume: (input as any).resume.payload }),
            threadConfig,
          );
        }

        /* ───────── Flush Tracing ───────── */
        await tracingProvider.flush?.();

        // Giữ nguyên logic bóc tách State đặc thù của đồ thị Multi-Agent
        const state = finalState.finalize ?? finalState.supervisor ?? finalState;

        if (state.error) {
          return {
            run_id: requestId,
            thread_id: ctx.thread_id,
            request_id: requestId,
            status: "error",
            error: {
              code: "GRAPH_ERROR",
              message: String(state.error),
            },
          };
        }

        const skillsUsed = (state.skill_results || [])
          .filter((r: any) => r.success)
          .map((r: any) => r.skill);

        // 🛡️ 2. MIDDLEWARE: afterAgent (Ghi log, dọn dẹp)
        const logEntries: string[] = [];
        const traceEntries: Record<string, unknown>[] = [];
        await runMiddlewarePhase(middlewareStack, 'afterAgent', mwCtx, {
            logs: logEntries,
            traces: traceEntries,
        });

        return {
          run_id: requestId,
          thread_id: ctx.thread_id,
          request_id: requestId,
          status: "completed",
          assistant: {
            text: state.finalAnswer || state.final_text || "",
          },
          meta: {
            latency_ms: Date.now() - startMs,
            skills_used: skillsUsed,
          },
        };
      } catch (e: any) {
        await tracingProvider.flush?.();
        logger.error("invoke failed", e);

        return {
          run_id: requestId,
          thread_id: ctx.thread_id,
          request_id: requestId,
          status: "error",
          error: {
            code: "INTERNAL",
            message: e?.message || "Unknown error",
          },
        };
      }
    },
    /* ──────────────────────────────────────────
     * STREAM (Đã fix xung đột Dual-Agent)
     * ────────────────────────────────────────── */

    async *stream(
      input: AgentInput,
      ctx: AgentContext,
    ): AsyncIterable<AgentEvent> {
      let seq = 1;
      const requestId = ctx.request_id ?? uuidv4();
      const ts = () => new Date().toISOString();

      // yield {
      //   type: "run.started",
      //   run_id: requestId,
      //   thread_id: ctx.thread_id,
      //   ts: ts(),
      //   seq: seq++,
      // };

      // 🛡️ 1. MIDDLEWARE: beforeAgent (Bảo vệ dữ liệu, setup context)
      const mwCtx = createMiddlewareContext({
          user_key: ctx.user_key,
          thread_id: ctx.thread_id,
          request_id: requestId,
          tool_policy: (input as any).options?.tool_policy,
      });
      await runMiddlewarePhase(middlewareStack, 'beforeAgent', mwCtx);

      /* ───────── Tracing Callback ───────── */
      const tracingCb = tracingProvider.createCallbackHandler({
          threadId: ctx.thread_id,
          userId: ctx.user_key,
          requestId,
          input: {
            message: input.kind === "message" ? input.message.text : "[resume]",
            student_id: ctx.user_key,
          },
          tags: ["multi-agent", "stream"],
      });

      try {
        /* ───────── Thread Config ───────── */
        const threadConfig: Record<string, any> = {
            configurable: {
                thread_id: ctx.thread_id,
                student_id: ctx.user_key,
                request_id: requestId,
                is_dual: ctx.is_dual,
            },
  
            streamMode: ['updates'] 
        };

        if (tracingCb) threadConfig.callbacks = [tracingCb];

        const iterable = input.kind === "message"
            ? await graph.stream({ messages: [new HumanMessage(input.message.text)] }, threadConfig)
            : await graph.stream(new Command({ resume: (input as any).resume.payload }), threadConfig);

        let currentRunId = '';
        let accumulatedDelta = '';
        let finalStateRef: any = null;
        let skillsUsed: string[] = [];

        for await (const chunk of iterable) {
            const [mode, payload] = chunk as any;

            /* ──────────────────────────────
             * LUỒNG 1: BẮT TỪNG TOKEN CỦA LLM
             * ────────────────────────────── */
            if (mode === 'messages') {
                const [msg, metadata] = payload;
                const msgType = msg?._getType?.() ?? msg?.getType?.() ?? '';
                const node = metadata?.langgraph_node ?? '';

                // const allowedNodes = [
                //     'supervisor', 
                //     'academic_agent', 
                //     'schedule_agent', 
                //     'faculty_agent', 
                //     'finalize'
                // ];
                // const isFinalNode = allowedNodes.includes(node);

                if (msgType !== 'human' && msgType !== 'system') {   
                    const runId = metadata?.run_id || msg?.id;

                    // Phát hiện LLM bị đổi hoặc gọi lại (Retry)
                    if (runId && runId !== currentRunId) {
                        if (currentRunId !== '') {
                            logger.warn(`🔄 [Multi-Agent Stream] Đổi LLM/Retry! RunID cũ: ${currentRunId} -> Mới: ${runId}`);
                        }
                        currentRunId = runId;
                        accumulatedDelta = '';
                        
                        yield { type: 'message.start', node, seq: seq++ };
                    }

                    if (msg?.content) {
                        const delta = messageText(msg);
                        if (delta) {
                            accumulatedDelta += delta;
                            yield { type: 'message.delta', delta, node, seq: seq++ };
                        }
                    }
                }
            }

            /* ──────────────────────────────
             * LUỒNG 2: BẮT TRẠNG THÁI STATUS (UPDATES)
             * ────────────────────────────── */
            else if (mode === 'updates') {
                for (const [node, state] of Object.entries(payload as any)) {
                    const s = state as any;

                    // Lưu finalState để xử lý ghép chữ hậu kỳ
                    if (node === 'finalize' && (s?.final_text || s?.finalAnswer)) {
                        finalStateRef = s;
                        const fullText = s.final_text || s.finalAnswer;
                        yield { type: 'message.delta', delta: fullText, node, seq: seq++ };
                        
                        yield { type: 'message.delta', delta: '[COMPOSE_DONE]', node, seq: seq++ };
                        accumulatedDelta = fullText;
                    }

                    if (s?.skill_results) {
                        skillsUsed = s.skill_results.filter((r: any) => r.success).map((r: any) => r.skill);
                    }

                    // 🔥 Bắn UI Status theo đúng đồ thị của đồng nghiệp
                    if (node === 'load_context') {
                        yield { type: 'message.delta', delta: '[STATUS:Đang tải ngữ cảnh...]', node, seq: seq++ };
                    }
                    if (node === 'supervisor') {
                        yield { type: 'message.delta', delta: '[STATUS:Supervisor đang phân tích...]', node, seq: seq++ };
                    }
                    if (node === 'execute_skills') {
                        yield { type: 'message.delta', delta: '[STATUS:Đang gọi kỹ năng...]', node, seq: seq++ };
                    }
                    if (node === 'finalize') {
                        yield { type: 'message.delta', delta: '[STATUS:Đang hoàn thiện câu trả lời...]', node, seq: seq++ };
                    }
                }
            }
        }

        /* ──────────────────────────────
         * XỬ LÝ HẬU KỲ (Citations & Appended Texts)
         * ────────────────────────────── */
        if (finalStateRef?.final_text || finalStateRef?.finalAnswer) {
            const finalText = finalStateRef.final_text || finalStateRef.finalAnswer;
            const trimmedAccum = accumulatedDelta.trim();
            const trimmedFinal = finalText.trim();

            // Lấy phần đuôi (như "🔗 Thông tin tham khảo:") được nối vào cuối đồ thị
            if (trimmedFinal.length > trimmedAccum.length &&
                trimmedFinal.startsWith(trimmedAccum.slice(0, Math.max(trimmedAccum.length - 20, 0)))) {
                
                const appendedSuffix = trimmedFinal.slice(trimmedAccum.length);
                if (appendedSuffix.trim()) {
                    yield { type: 'message.delta', delta: appendedSuffix, node: 'postprocess', seq: seq++ };
                }
            }
        }

        // 🛡️ 2. MIDDLEWARE: afterAgent (Ghi log, dọn dẹp)
        const logEntries: string[] = [];
        const traceEntries: Record<string, unknown>[] = [];
        await runMiddlewarePhase(middlewareStack, 'afterAgent', mwCtx, {
            logs: logEntries,
            traces: traceEntries,
        });

        await tracingProvider.flush?.();

        // yield {
        //     type: "run.completed",
        //     status: "completed",
        //     skills_used: skillsUsed,
        //     seq: seq++,
        // };

      } catch (e: any) {
        await tracingProvider.flush?.();
        logger.error("[MULTI-AGENT STREAM ERROR]", e);
        yield {
          type: "run.failed",
          error: { code: "STREAM_ERROR", message: e?.message || "Unknown stream error" },
          seq: seq++,
        };
      }
    },
  };
}
