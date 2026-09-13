import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { v4 as uuidv4 } from 'uuid';
import { createGraph } from '@/agent/graph/graph/root.graph';
import { SkillRegistry } from '@/agent/skills/registry';

import { createAcademicSkill } from '../skills/academic_new.skill';
import { createScheduleSkill } from '../skills/schedule_new.skill';
import { createCourseInfoSkill } from '../skills/course_info.skill';
import { createProgramSkill } from '../skills/program_new.skill';
import { createGradeLookupSkill } from '../skills/grade_lookup.skill';
import { createStudentInfoSkill } from '../skills/student_info.skill';
import { createTeacherTopicsSkill } from '../skills/teacher_topics.skill';
import { createCompanyTopicsSkill } from '../skills/company_topics.skill';
import { createPolicySearchSkill } from '@/agent/skills/policy-search.skill';
import { TopicCacheService } from '../services/topic-cache.service';

import { LlmFactory, DEFAULT_LLM_REGISTRY } from '@/agent/llm/llm.factory';
import { PromptLoader } from '@/agent/prompts/prompt-loader';
import { createMongoSaver } from '@/agent/persistence/checkpointer';
import { HistoryStore } from '@/agent/persistence/history.store';
import { HustApiClient } from '@/agent/tools/clients/hust-api.client';
import { RedisClient } from '@/agent/tools/clients/redis.client';
import { EHustDbApiClient } from '@/agent/tools/clients/ehust-db.client';
import { createLogger } from '@/common/logger/logger';
import { messageText } from '@/common/utils/llm-content';

// Middleware pipeline
import {
    AgentMiddleware,
    createMiddlewareContext,
    runMiddlewarePhase,
} from '@/agent/middleware/types';
import { contextInjectorMiddleware } from '@/agent/middleware/context-injector.middleware';
import { createStuckDetectorMiddleware } from '@/agent/middleware/stuck-detector.middleware';
import { piiRedactorMiddleware } from '@/agent/middleware/pii-redactor.middleware';

// Tracing — @langfuse/langchain CallbackHandler + explicit flush after invoke
import { createTracingProvider } from '@/agent/tracing/index';

const logger = createLogger('AgentFacade');

// ─── Public Types ─────────────────────────────────────────────────────────────

export type AgentContext = {
    user_key: string;   // studentId
    thread_id: string;
    request_id: string;
    is_dual?: boolean;
};

export type AgentInput =
    | {
        kind: 'message';
        message: { text: string };
        /** Ảnh đính kèm cho lượt này (data-URI đã qua sanitizeImages). */
        images?: string[];
        options?: {
            trace?: boolean;
            locale?: 'vi' | 'en';
            tool_policy?: { allow?: string[]; deny?: string[] };
        };
    }
    | {
        kind: 'resume';
        resume: { payload: unknown };
        options?: { trace?: boolean };
    };

export type FinalResult = {
    run_id: string;
    thread_id: string;
    request_id: string;
    status: 'completed' | 'error';
    assistant?: {
        text: string;
        citations?: Array<{ source: string; id: string; title?: string; section?: string; link?: string }>;
    };
    error?: { code: string; message: string };
    meta?: { skills_used: string[]; intent?: string; latency_ms: number; tokens?: { input_tokens: number; output_tokens: number; total_tokens: number } };
};

export interface AgentFacade {
    invoke(input: AgentInput, ctx: AgentContext): Promise<FinalResult>;
    stream(input: AgentInput, ctx: AgentContext): AsyncIterable<AgentEvent>;
}

export type AgentEvent =
    | { type: 'run.started'; run_id: string; thread_id: string; ts: string; seq: number }
    | { type: 'message.start'; node?: string; seq: number }
    | { type: 'message.delta'; delta: string; node?: string; seq: number }
    | { type: 'run.completed'; status: string; skills_used?: string[]; title?: string; seq: number }
    | { type: 'run.failed'; error: { code: string; message: string }; seq: number };

// ─── Factory ──────────────────────────────────────────────────────────────────

export function buildAgentFacade(deps: {
    mongoClient?: any;
    historyStore?: HistoryStore;
}): AgentFacade {
    // ── Infrastructure clients ─────────────────────────────────────────────
    const hustApi = new HustApiClient();
    const redis = new RedisClient();
    const topicCacheService = new TopicCacheService(redis, hustApi);

    // ── LLM + Prompts ──────────────────────────────────────────────────────
    const llmFactory = new LlmFactory(DEFAULT_LLM_REGISTRY);
    const promptLoader = new PromptLoader();

    // ── Skill registry ─────────────────────────────────────────────────────
    const registry = new SkillRegistry();
    registry.register(createAcademicSkill(redis));
    registry.register(createScheduleSkill(redis));
    registry.register(createCourseInfoSkill(redis));
    registry.register(createProgramSkill(redis));
    registry.register(createGradeLookupSkill(redis));
    registry.register(createStudentInfoSkill(redis));
    // 2 skills có nhúng LLM 
    registry.register(createTeacherTopicsSkill(redis, hustApi, topicCacheService));
    registry.register(createCompanyTopicsSkill(redis, hustApi, topicCacheService));
    // Skill cũ giữ lại
    registry.register(createPolicySearchSkill());


    // ── Checkpointer (MongoDB or in-memory fallback) ───────────────────────
    const checkpointer = deps.mongoClient
        ? createMongoSaver(deps.mongoClient)
        : undefined;

    // ── Compile graph ──────────────────────────────────────────────────────
    const graph = createGraph(checkpointer, deps.historyStore, registry, llmFactory, promptLoader, hustApi, redis);

    // Tracing provider — Langfuse or Noop
    const tracingProvider = createTracingProvider();

    // ── Middleware stack ───────────────────────────────────────────────────
    const middlewareStack: AgentMiddleware[] = [
        contextInjectorMiddleware,
        createStuckDetectorMiddleware({ maxToolFailures: 3, maxLoops: 5 }),
        piiRedactorMiddleware,
    ];

    // ─── invoke (sync) ─────────────────────────────────────────────────────
    return {
        async invoke(input: AgentInput, ctx: AgentContext): Promise<FinalResult> {
            const startMs = Date.now();
            logger.info('invoke start', { thread: ctx.thread_id, student: ctx.user_key });

            // 1. Middleware: beforeAgent
            const mwCtx = createMiddlewareContext({
                user_key: ctx.user_key,
                thread_id: ctx.thread_id,
                request_id: ctx.request_id,
                tool_policy: (input as any).options?.tool_policy,
            });
            await runMiddlewarePhase(middlewareStack, 'beforeAgent', mwCtx);

            // 2. Build LangGraph threadConfig
            const threadConfig: Record<string, any> = {
                configurable: {
                    thread_id: ctx.thread_id,
                    student_id: ctx.user_key,
                    request_id: ctx.request_id,
                    is_dual: ctx.is_dual,
                },
            };

            // 3. Attach @langfuse/langchain CallbackHandler
            const tracingCb = tracingProvider.createCallbackHandler({
                threadId: ctx.thread_id,
                userId: ctx.user_key,
                requestId: ctx.request_id,
                input: {
                    message: input.kind === 'message' ? input.message.text : '[resume]',
                    student_id: ctx.user_key,
                },
                tags: ['invoke'],
            });
            if (tracingCb) threadConfig.callbacks = [tracingCb];

            let finalState: Record<string, any>;

            try {
                if (input.kind === 'message') {
                    finalState = await graph.invoke(
                        { messages: [new HumanMessage(input.message.text)], images: input.images ?? [] },
                        threadConfig,
                    );
                } else {
                    finalState = await graph.invoke(
                        new Command({ resume: input.resume.payload }),
                        threadConfig,
                    );
                }
                // CRITICAL: flush after invoke — CallbackHandler buffers in long-running servers
                await tracingProvider.flush?.();
            } catch (e: any) {
                await tracingProvider.flush?.();
                return {
                    run_id: ctx.request_id,
                    thread_id: ctx.thread_id,
                    request_id: ctx.request_id,
                    status: 'error',
                    error: { code: 'INTERNAL', message: e?.message || 'Graph execution failed' },
                };
            }

            if (finalState.error) {
                return {
                    run_id: ctx.request_id,
                    thread_id: ctx.thread_id,
                    request_id: ctx.request_id,
                    status: 'error',
                    error: { code: finalState.error.code, message: finalState.error.message },
                    assistant: finalState.final_text ? { text: finalState.final_text } : undefined,
                };
            }

            const skillsUsed: string[] = (finalState.skill_results || [])
                .filter((r: any) => r.success)
                .map((r: any) => r.skill);

            // 4. Middleware: afterAgent
            const logEntries: string[] = [];
            const traceEntries: Record<string, unknown>[] = [];
            await runMiddlewarePhase(middlewareStack, 'afterAgent', mwCtx, {
                logs: logEntries,
                traces: traceEntries,
            });

            return {
                run_id: ctx.request_id,
                thread_id: ctx.thread_id,
                request_id: ctx.request_id,
                status: 'completed',
                assistant: {
                    text: finalState.final_text || '',
                    citations: finalState.citations || [],
                },
                meta: {
                    skills_used: skillsUsed,
                    intent: finalState.routing?.intent,
                    latency_ms: Date.now() - startMs,
                    tokens: finalState.token_usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
            };
        },

        // ─── stream (SSE) ──────────────────────────────────────────────────
        async * stream(input: AgentInput, ctx: AgentContext): AsyncIterable<AgentEvent> {
            let seq = 1;
            const ts = () => new Date().toISOString();

            yield { type: 'run.started', run_id: ctx.request_id, thread_id: ctx.thread_id, ts: ts(), seq: seq++ };

            // 1. Middleware: beforeAgent
            const mwCtx = createMiddlewareContext({
                user_key: ctx.user_key,
                thread_id: ctx.thread_id,
                request_id: ctx.request_id,
                tool_policy: (input as any).options?.tool_policy,
            });
            await runMiddlewarePhase(middlewareStack, 'beforeAgent', mwCtx);

            // 2. Build LangGraph threadConfig
            const threadConfig: Record<string, any> = {
                configurable: {
                    thread_id: ctx.thread_id,
                    student_id: ctx.user_key,
                    request_id: ctx.request_id,
                    is_dual: ctx.is_dual,
                },
                streamMode: ['messages', 'updates'] as ['messages', 'updates'],
            };

            // 3. Attach Langfuse tracing callback
            const tracingCb = tracingProvider.createCallbackHandler({
                threadId: ctx.thread_id,
                userId: ctx.user_key,
                requestId: ctx.request_id,
                input: {
                    message: input.kind === 'message' ? input.message.text : '[resume]',
                    student_id: ctx.user_key,
                },
                tags: ['stream'],
            });
            if (tracingCb) threadConfig.callbacks = [tracingCb];

            try {
                let iterable: AsyncIterable<any>;
                if (input.kind === 'message') {
                    iterable = await graph.stream(
                        { messages: [new HumanMessage(input.message.text)], images: input.images ?? [] },
                        threadConfig as any,
                    );
                } else {
                    iterable = await graph.stream(
                        new Command({ resume: (input as any).resume.payload }),
                        threadConfig as any,
                    );
                }

                let skillsUsed: string[] = [];
                let accumulatedDelta = '';
                let finalStateRef: Record<string, any> | null = null;
                let currentRunId = ''; 
                let extractedTitle: string | undefined;

                for await (const chunk of iterable) {
                    const [mode, payload] = chunk;
                    if (mode === 'messages') {
                        // payload thực chất là mảng [msg, metadata]
                        const [msg, metadata] = payload;
                        
                        const msgType = msg?._getType?.() ?? msg?.getType?.() ?? '';
                        const node = metadata?.langgraph_node ?? '';
                        const isFinalNode = node === 'compose';
                        
                        if (msgType !== 'human' && msgType !== 'system' && isFinalNode) {
                            
                            // 🌟 LẤY RUN_ID CỦA LANGCHAIN (Đảm bảo thay đổi 100% mỗi lần invoke)
                            const runId = metadata?.run_id || msg.id;

                            if (runId && runId !== currentRunId) {
                                // Nếu không phải lần chạy đầu tiên -> Chứng tỏ là đang Retry
                                if (currentRunId !== '') {
                                    logger.warn(`🔄 [Stream Retry] Phát hiện LLM gọi lại! RunID cũ: ${currentRunId} -> Mới: ${runId}. Bắn tín hiệu xóa UI!`);
                                }
                                
                                currentRunId = runId; 
                                accumulatedDelta = ''; // Xóa sạch bộ đệm Backend
                                
                                yield { 
                                    type: 'message.start', 
                                    node, 
                                    seq: seq++ 
                                };
                            }

                            if (msg?.content) {
                                const delta = messageText(msg);
                                if (delta) {
                                    accumulatedDelta += delta;
                                    yield {
                                        type: 'message.delta',
                                        delta,
                                        node,
                                        seq: seq++,
                                    };
                                }
                            }
                        }
                    } else if (mode === 'updates') {
                        // Cập nhật log skills
                        if (payload?.execute_skills?.skill_results) {
                            skillsUsed = payload.execute_skills.skill_results
                                .filter((r: any) => r.success)
                                .map((r: any) => r.skill);
                        }

                        if (payload?.generate_title?.thread_title) {
                            extractedTitle = payload.generate_title.thread_title;
                        }

                        // 🔥 1. NẾU NODE COMPOSE VỪA CHẠY XONG -> CHỐT CÂU TRẢ LỜI
                        if (payload?.compose?.final_text) {
                            finalStateRef = payload.compose;
                            yield { 
                                type: 'message.delta', 
                                delta: '[COMPOSE_DONE]', 
                                node: 'system_status', 
                                seq: seq++ 
                            };
                        } 
                        // 🔥 2. NẾU REACT, SIGNAL_ROUTER, HOẶC EXECUTE_SKILLS XONG -> CHUẨN BỊ VÀO COMPOSE
                        else if (payload?.react) {
                             // Đã có data từ Tools. Bắt đầu nhồi vào LLM ở Compose Node
                             yield { 
                                 type: 'message.delta', 
                                 delta: '[STATUS:Đang tổng hợp dữ liệu...]', 
                                 node: 'system_status', 
                                 seq: seq++ 
                             };
                        }
                        // 🔥 3. NẾU LOAD_CONTEXT XONG -> CHUẨN BỊ VÀO REACT / ROUTER
                        else if (payload?.load_context) {
                             // Bắt đầu đi tìm xem dùng tool nào và gọi API trường
                             yield { 
                                 type: 'message.delta', 
                                 delta: '[STATUS:Đang truy xuất hệ thống...]', 
                                 node: 'system_status', 
                                 seq: seq++ 
                             };
                        }
                    }
                }

                // ── Emit citation append delta ──────────────────────────────────────────
                // node.compose.ts appends "🔗 Thông tin tham khảo:" AFTER model.invoke() completes.
                // This post-processing does NOT appear in SSE message chunks (only LLM tokens stream).
                // So we compare final_text with what was accumulated and emit the diff.
                if (finalStateRef?.final_text) {
                    const finalText: string = finalStateRef.final_text;
                    // Find the suffix that was appended after the LLM output
                    const trimmedAccum = accumulatedDelta.trim();
                    const trimmedFinal = finalText.trim();
                    if (trimmedFinal.length > trimmedAccum.length &&
                        trimmedFinal.startsWith(trimmedAccum.slice(0, Math.max(trimmedAccum.length - 20, 0)))) {
                        const appendedSuffix = trimmedFinal.slice(trimmedAccum.length);
                        if (appendedSuffix.trim()) {
                            yield {
                                type: 'message.delta',
                                delta: appendedSuffix,
                                node: 'compose_citations',
                                seq: seq++,
                            };
                        }
                    }
                }

                // 4. Middleware: afterAgent
                const logEntries: string[] = [];
                const traceEntries: Record<string, unknown>[] = [];
                await runMiddlewarePhase(middlewareStack, 'afterAgent', mwCtx, {
                    logs: logEntries,
                    traces: traceEntries,
                });

                yield { type: 'run.completed', status: 'completed', skills_used: skillsUsed, title: extractedTitle, seq: seq++ };
            } catch (e: any) {
                yield {
                    type: 'run.failed',
                    error: { code: 'INTERNAL', message: e?.message || 'Stream error' },
                    seq: seq++,
                };
            }
        },
    };
}