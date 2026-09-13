import { SkillResult } from '../../graph/state';

export interface ToolOutput<T = unknown> {
    tool: string;
    success: boolean;

    summary: string;

    data?: T;

    instruction?: string;

    error?: string;
}

export function formatToolOutput<T>(
    toolName: string,
    sr: SkillResult | undefined
): ToolOutput<T> {
    if (!sr) {
        return {
            tool: toolName,
            success: false,
            summary: 'Tool không trả về kết quả',
            error: 'NO_RESULT',
        };
    }

    if (!sr.success) {
        return {
            tool: toolName,
            success: false,
            summary: sr.error ?? 'Tool execution failed',
            error: sr.error,
        };
    }

    return {
        tool: toolName,
        success: true,

        summary:
            sr.llm_instruction ??
            `Tool ${toolName} executed successfully`,

        instruction: sr.llm_instruction,

        data: sr.data as T,
    };
}