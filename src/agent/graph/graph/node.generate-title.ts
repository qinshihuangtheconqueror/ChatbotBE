import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from './state';
import { LlmFactory } from '../../llm/llm.factory';
import { createLogger } from '@/common/logger/logger';
import { messageText } from '@/common/utils/llm-content';

const logger = createLogger('GenerateTitleNode');

const TITLE_PROMPT = `BẠN LÀ CÔNG CỤ ĐẶT TÊN TIÊU ĐỀ CUỘC TRÒ CHUYỆN.
Nhiệm vụ: Đọc câu hỏi của người dùng và câu trả lời của AI, sau đó đặt một tiêu đề RẤT NGẮN GỌN, SÚC TÍCH (tối đa 4-6 từ) để tóm tắt chủ đề chính.
KHÔNG dùng dấu ngoặc kép, KHÔNG giải thích. TRÁNH đặt tên ở DẠNG CÂU HỎI.
TRẢ VỀ ĐÚNG ĐỊNH DẠNG JSON: {"title": "Tiêu đề ở đây"}`;

export function createGenerateTitleNode(llmFactory?: LlmFactory) {
    return async function generateTitleNode(
        state: typeof StateAnnotation.State,
        _config?: LangGraphRunnableConfig,
    ): Promise<Partial<typeof StateAnnotation.State>> {
        
        const messages = state.messages ?? [];
        // Lấy câu hỏi đầu tiên của User và câu trả lời của AI
        const firstHumanMsg = messages.find(m => m._getType() === 'human')?.content || '';
        const aiResponse = messages[messages.length - 1]?.content || '';

        if (!firstHumanMsg || !llmFactory) {
            return {};
        }

        try {
            // Dùng model Lite 
            const model = llmFactory.getModel('react'); 
            
            const result = await model.invoke([
                { role: 'system', content: TITLE_PROMPT },
                { 
                  role: 'user', 
                  content: `Hỏi: ${String(firstHumanMsg).slice(0, 500)}\n\nĐáp: ${String(aiResponse).slice(0, 500)}` 
                }
            ]);

            const responseText = messageText(result);
            let generatedTitle = String(firstHumanMsg).slice(0, 30) + "..."; // Fallback an toàn

            try {
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    generatedTitle = parsed.title || generatedTitle;
                }
            } catch (parseError) {
                logger.warn('LLM trả về JSON title lỗi', { responseText });
            }

            logger.info('Thread title generated', { 
                threadId: _config?.configurable?.thread_id, 
                title: generatedTitle 
            });

            return {
                thread_title: generatedTitle,
            };

        } catch (error) {
            logger.error('Error generating title', { error: String(error) });
            return {}; 
        }
    };
}

export function shouldGenerateTitle(s: typeof StateAnnotation.State): string {
    if (s.error) return 'handle_error';
    
    // Giả định: Lượt đầu tiên sẽ có 1 câu hỏi và 1 câu trả lời trong mảng messages 
    // (hoặc tuỳ thuộc vào logic lưu messages của bạn, thường <= 2 hoặc 3)
    const isFirstTurn = s.messages.length <= 3; 
    const hasNoTitle = !s.thread_title;

    if (isFirstTurn && hasNoTitle) {
        return 'generate_title';
    }
    return 'finalize';
}