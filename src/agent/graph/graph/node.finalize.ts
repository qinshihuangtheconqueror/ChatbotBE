import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { StateAnnotation } from './state';
import { HistoryStore } from '../../persistence/history.store';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('FinalizeNode-Single');

export async function finalizeNode(
    state: typeof StateAnnotation.State,
    config?: LangGraphRunnableConfig,
    historyStore?: HistoryStore,
): Promise<Partial<typeof StateAnnotation.State>> {
    const text = state.final_text || 'Xin lỗi, không thể xử lý yêu cầu của bạn lúc này.';
    const aiMessage = new AIMessage(text);

    const threadId = config?.configurable?.thread_id as string | undefined;
    const studentId = config?.configurable?.student_id as string | undefined;
    const threadTitle = state.thread_title;
    
    // 🔥 Đọc cờ is_dual từ Facade truyền xuống
    const isDual = config?.configurable?.is_dual as boolean | undefined;

    const allMessages = state.messages
        .filter(m => m.getType() !== 'system')
        .concat([aiMessage]);

    const updatedSummary = allMessages.slice(-10)
        .map(m => `${m.getType() === 'human' ? 'SV' : 'AI'}: ${(m.content || '').toString().substring(0, 80)}...`)
        .join('\n');
        
    // 🔥 CHIẾN THUẬT: CẤM LƯU NẾU ĐANG CHẠY DUAL
    if (historyStore && threadId && !isDual) {
        // Chỉ lưu DB khi đây là chế độ Single-Agent xịn (70% traffic)
        try {
            await historyStore.saveContext(
                threadId,
                studentId || 'anonymous',
                allMessages,    
                updatedSummary, 
                threadTitle 
            );
            logger.info('History saved (Single Mode)', { threadId, totalTurns: allMessages.length });
        } catch (e) {
            logger.error('Failed to save history', e, { threadId });
        }
    } else if (isDual) {
        logger.info('Bypassed DB saving because Dual Mode is active (ChatService will handle it).');
    }

    return {
        messages: [aiMessage],
        history_summary: updatedSummary, 
    };
}