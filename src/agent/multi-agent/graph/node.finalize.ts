import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { StateAnnotation } from './state';
import { HistoryStore } from '../../persistence/history.store';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('FinalizeNode-Multi');

export async function finalizeNode(
    state: typeof StateAnnotation.State,
    config?: LangGraphRunnableConfig,
    historyStore?: HistoryStore,
): Promise<Partial<typeof StateAnnotation.State>> {
    
    const text = state.final_text || (state as any).finalAnswer || 'Xin lỗi, không thể xử lý yêu cầu của bạn lúc này.';
    const aiMessage = new AIMessage(text);

    const threadId = config?.configurable?.thread_id as string | undefined;
    const studentId = config?.configurable?.student_id as string | undefined;
    const isDual = config?.configurable?.is_dual as boolean | undefined;

    const lastHumanMessage = [...state.messages].reverse().find(m => m.getType() === 'human');
    const updatedSummary = (state.history_summary || '') +
        `\nSV: ${(lastHumanMessage?.content || '').toString().substring(0, 80)}...\nAI: ${text.substring(0, 80)}...`;
        
    // 🔥 CHIẾN THUẬT RÕ RÀNG: Nếu đang chạy Dual, KHÔNG LƯU GÌ CẢ. 
    // Mọi việc ChatService và saveDualContext sẽ lo.
    if (historyStore && threadId && !isDual) {
        // Chỉ lưu khi bạn cấu hình Graph này chạy độc lập (không qua ChatService Dual Mode)
        try {
            const allMessages = state.messages.filter(m => m.getType() !== 'system').concat([aiMessage]);
            await historyStore.saveContext(
                threadId, studentId || 'anonymous', allMessages, updatedSummary, state.thread_title 
            );
        } catch (e) {
            logger.error('Failed to save history', e, { threadId });
        }
    }

    return {
        ...state,
        messages: [aiMessage],
        final_text: text,
        history_summary: updatedSummary,
    };
}