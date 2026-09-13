import { tool } from "@langchain/core/tools";

import { createPolicySearchSkill } from "../../skills/policy-search.skill";

import {
    HumanMessage,
    SystemMessage,
    BaseMessage,
} from "@langchain/core/messages";

import { z } from "zod";

import { AppState } from "../graph/state";

export function createSubAgentTools(
    academicAgent: any,
    scheduleAgent: any,
    falcutyAgent: any,
) {
    const policySkill = createPolicySearchSkill();

    /* ──────────────────────────────────────────
     * Build Messages
     * ────────────────────────────────────────── */

    function buildMessages(query: string, state: AppState): BaseMessage[] {
        const messages: BaseMessage[] = [];

        let studentContext: string | null = null;

        for (const msg of state.messages) {
            if (
                msg instanceof SystemMessage &&
                typeof msg.content === "string" &&
                msg.content.includes("Student context:")
            ) {
                studentContext = msg.content;
                break;
            }
        }

        if (studentContext) {
            messages.push(
                new SystemMessage(
                    [
                        studentContext,

                        `
RULES:
- Always use default_semester if user does not specify semester
- Extract semester from query if possible
- If not, fallback to default_semester
                        `,
                    ].join("\n\n"),
                ),
            );
        }

        if (state.policy_contexts?.length) {
            messages.push(
                new SystemMessage(
                    [
                        "Retrieved policy context:",

                        ...state.policy_contexts.map(
                            (c: any, i: number) => `
[POLICY ${i + 1}]
TITLE: ${c.title}
SOURCE: ${c.source}

${c.content}
                    `,
                        ),
                    ].join("\n\n"),
                ),
            );
        }

        messages.push(new HumanMessage(query));

        return messages;
    }

    /* ──────────────────────────────────────────
     * Academic Tool
     * ────────────────────────────────────────── */

    const academicTool = tool(
        async (input, config) => {
            try {
                const messages = buildMessages(input.query, {
                    messages: input.context ?? [],
                } as AppState);

                const response = await academicAgent.invoke({
                    messages,
                }, config);

                const lastMessage = response.messages.at(-1);

                return typeof lastMessage?.content === "string"
                    ? lastMessage.content
                    : JSON.stringify(lastMessage?.content);
            } catch (e) {
                return [
                    "STATUS: ERROR",
                    "MESSAGE: academic tool failed",
                    `DETAIL: ${String(e)}`,
                ].join("\n");
            }
        },

        {
            name: "academic_tool",

            description:
                `Sử dụng công cụ này để xử lý các câu hỏi về thông tin học tập CÁ NHÂN của sinh viên.
Bao gồm: 
- Tra cứu điểm số, điểm thành phần, điểm trung bình học kỳ (GPA), điểm tích lũy (CPA).
- Tra cứu trạng thái học tập, tổng kết học kỳ, số tín chỉ đã tích lũy/còn thiếu.
- Các vấn đề về môn học sinh viên đã đăng ký, lộ trình và tiến độ hoàn thành chương trình đào tạo cá nhân.
- Thông tin cụ thể của từng học phần`,

            schema: z.object({
                query: z.string(),
                context: z.array(z.any()).optional(),
            }),
        },
    );

    /* ──────────────────────────────────────────
     * Schedule Tool
     * ────────────────────────────────────────── */

    const scheduleTool = tool(
        async (input, config) => {
            try {
                const messages = buildMessages(input.query, {
                    messages: input.context ?? [],
                } as AppState);

                const response = await scheduleAgent.invoke({
                    messages,
                }, config);

                const lastMessage = response.messages.at(-1);

                return typeof lastMessage?.content === "string"
                    ? lastMessage.content
                    : JSON.stringify(lastMessage?.content);
            } catch (e) {
                return [
                    "STATUS: ERROR",
                    "MESSAGE: schedule tool failed",
                    `DETAIL: ${String(e)}`,
                ].join("\n");
            }
        },

        {
            name: "schedule_tool",

            description:
                "Handle schedule-related tasks such as classes, exams, and events.",

            schema: z.object({
                query: z.string(),
                context: z.array(z.any()).optional(),
            }),
        },
    );

    /* ──────────────────────────────────────────
     * Policy Tool
     * ────────────────────────────────────────── */

    const falcutyTool = tool(
        async (input, config) => {
            try {
                const messages = buildMessages(input.query, {
                    messages: input.context ?? [],
                } as AppState);

                const response = await falcutyAgent.invoke({
                    messages,
                }, config);

                const lastMessage = response.messages.at(-1);

                return typeof lastMessage?.content === "string"
                    ? lastMessage.content
                    : JSON.stringify(lastMessage?.content);
            } catch (e) {
                return [
                    "STATUS: ERROR",
                    "MESSAGE: policy tool failed",
                    `DETAIL: ${String(e)}`,
                ].join("\n");
            }
        },

        {
            name: "faculty_tool",

            description: `Use this tool to directly answer questions about:
- giảng viên
- đề tài nghiên cứu
- đồ án
- thực tập
- hướng nghiên cứu`,

            schema: z.object({
                query: z.string(),
                context: z.array(z.any()).optional(),
            }),
        },
    );

    const policyTool = tool(
        async (input) => {
            try {
                const result = await policySkill.run({
                    messages: [new HumanMessage(input.query)],

                    rewritten_query: input.query,
                } as any);

                const skillResult = result.skill_results?.[0];

                if (!skillResult?.success) {
                    return [
                        "STATUS: ERROR",
                        `DETAIL: ${skillResult?.error ?? "Unknown error"}`,
                    ].join("\n");
                }

                const chunks: any = skillResult.data?.chunks ?? [];

                if (!chunks.length) {
                    return "Không tìm thấy tài liệu phù hợp.";
                }

                return JSON.stringify({
                    policy_contexts: chunks.map((c: any) => ({
                        title: c.title,
                        content: c.context,
                        source: c.link,
                    })),
                });
            } catch (e) {
                return [
                    "STATUS: ERROR",
                    "MESSAGE: policy tool failed",
                    `DETAIL: ${String(e)}`,
                ].join("\n");
            }
        },

        {
            name: "policy_tool",

            description: `Use this tool for:
- quy chế
- học bổng
- cảnh báo học tập
- chính sách đào tạo
- quy định học vụ
- chuẩn đầu ra
- văn bản HUST
- policy
- regulation`,

            schema: z.object({
                query: z.string(),
            }),
        },
    );

    return [academicTool, scheduleTool, falcutyTool, policyTool];
}
