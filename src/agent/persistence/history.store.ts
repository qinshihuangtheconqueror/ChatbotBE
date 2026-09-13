import { BaseMessage } from '@langchain/core/messages';

/**
 * Agent-side port for conversation history.
 * Pure contract — no NestJS or DB imports here.
 * Implementation lives in server/services/history.service.ts
 */
export interface HistoryStore {
    loadContext(
        threadId: string,
        studentId: string,
    ): Promise<{ turns: BaseMessage[]; summary: string }>;

    saveContext(
        threadId: string,
        studentId: string,
        turns: BaseMessage[],
        summary: string,
        threadTitle?: string,
    ): Promise<void>;

    saveDualContext?(
        threadId: string,
        studentId: string,
        userQuery: string,
        contentA: string,
        contentB: string,
        threadTitle?: string,
    ): Promise<void>;
}
