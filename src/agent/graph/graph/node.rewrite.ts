import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from './state';
import { LlmFactory } from '../../llm/llm.factory';
import { PromptLoader } from '../../prompts/prompt-loader';
import { createLogger } from '@/common/logger/logger';
import { messageText } from '@/common/utils/llm-content';

const logger = createLogger('RewriteNode');


const REWRITE_PROMPT_FALLBACK = `BẠN LÀ MỘT CÔNG CỤ XỬ LÝ CHUỖI KÝ TỰ (STRING PARSER). BẠN KHÔNG PHẢI LÀ CHATBOT. KHÔNG ĐƯỢC GIAO TIẾP.
Nhiệm vụ: Phân tích "Lịch sử hội thoại" để viết lại "Câu hỏi mới nhất" thành một CÂU HỎI ĐỘC LẬP (hoặc TỪ KHÓA TÌM KIẾM ĐỘC LẬP).

KỶ LUẬT BẮT BUỘC (SẼ BỊ PHẠT NẾU VI PHẠM):
1. TUYỆT ĐỐI KHÔNG TRẢ LỜI CÂU HỎI. (Ví dụ: Nếu người dùng hỏi "bạn là ai", kết quả trả về chính xác chữ "bạn là ai").
2. TUYỆT ĐỐI KHÔNG TỰ CHẾ THÊM Ý. Không được thêm các cụm từ như "điều kiện là gì", "như thế nào" nếu trong câu gốc không có.
3. Nếu là lời chào, lời cảm ơn, hoặc câu giao tiếp, HÃY GIỮ NGUYÊN VĂN.
4. BẮT BUỘC trả về kết quả ĐÚNG CÚ PHÁP JSON SAU ĐÂY. KHÔNG BỌC TRONG MARKDOWN, KHÔNG THÊM LỜI GIẢI THÍCH NÀO KHÁC.

OUTPUT FORMAT:
{
  "needRewrite": true | false,
  "standaloneQuestion": "<câu hỏi độc lập hoặc nguyên văn câu hỏi gốc>"
}`;

export function createRewriteNode(llmFactory?: LlmFactory, promptLoader?: PromptLoader) {
    return async function rewriteNode(
        state: typeof StateAnnotation.State,
        _config?: LangGraphRunnableConfig,
    ): Promise<Partial<typeof StateAnnotation.State>> {
        
        if (state.routing?.intent === 'privacy_blocked') {
            logger.info('Bỏ qua Rewrite do câu hỏi bị chặn bởi Privacy Guard.');
            return {}; 
        }
        // Lấy câu hỏi cuối cùng
        const messages = state.messages ?? [];
        const lastMsg = messages[messages.length - 1];
        const rawQuery = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

        if (!rawQuery.trim() || !llmFactory) {
            return { rewritten_query: rawQuery };
        }

        try {
            const model = llmFactory.getModel('lite'); 
            
            // ─── 1. LẤY PROMPT TỪ FILE ───
            const systemPrompt = promptLoader
                ? await promptLoader.getPrompt('rewrite').catch(() => REWRITE_PROMPT_FALLBACK)
                : REWRITE_PROMPT_FALLBACK;

            // ─── 2. TRÍCH XUẤT LỊCH SỬ HỘI THOẠI ───
            const historyMsgs = messages.slice(Math.max(0, messages.length - 5), -1);
            const historyText = historyMsgs.length > 0
                ? historyMsgs.map(m => `${m._getType() === 'human' ? 'Sinh viên' : 'HustVA'}: ${m.content}`).join('\n')
                : "(Không có lịch sử hội thoại)";

           // ─── 3. GỌI LLM (ABORT CONTROLLER) ───
            let result: any = null;
            let retryCount = 0;
            const MAX_RETRIES = 3;

            while (retryCount < MAX_RETRIES) {
                const controller = new AbortController();
                
                // Hủy request cứng sau 20 giây cho Rewrite
                const timeoutId = setTimeout(() => {
                    controller.abort();
                }, 20000);

                try {
                    result = await model.invoke(
                        [
                            { role: 'system', content: systemPrompt },
                            { 
                                role: 'user', 
                                content: `**Lịch sử hội thoại:**\n${historyText}\n\n**Câu hỏi mới nhất:**\n${rawQuery}` 
                            }
                        ],
                        { signal: controller.signal } // <-- Bơm tín hiệu hủy
                    );
                    
                    clearTimeout(timeoutId); // Dọn dẹp RAM
                    break; // Thành công thì thoát vòng lặp
                    
                } catch (err: any) {
                    clearTimeout(timeoutId); // Dọn dẹp RAM
                    retryCount++;
                    
                    const isStreamError = err?.message?.includes('parse stream') || err?.stack?.includes('parse stream');
                    if (isStreamError) {
                        logger.warn(`⚠️ [Stream Error] Phát hiện lỗi rãnh luồng từ Google Server. Tiến hành nạp lại kết nối.`);
                    }

                    logger.warn(`⚠️ [Rewrite Retry] Lỗi gọi Gemini (Lần ${retryCount}/${MAX_RETRIES}): ${err?.message || 'Lỗi không xác định'}`);
                    
                    if (retryCount >= MAX_RETRIES) {
                        throw err; // Hết cứu, ném lỗi ra ngoài
                    }
                    
                    // Backoff: 2s -> 4s -> 6s
                    await new Promise(resolve => setTimeout(resolve, retryCount * 2000));
                }
            }

            const responseText = messageText(result);

            // ─── 4. PARSE JSON TỪ LLM ───
            let standaloneQuestion = rawQuery; // Mặc định là câu gốc
            let usedHistory = false;

            try {
                // Dùng regex để trích xuất JSON trong trường hợp LLM bọc nó trong ```json ... ```
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    standaloneQuestion = parsed.standaloneQuestion || rawQuery;
                    usedHistory = parsed.needRewrite === true;
                }
            } catch (parseError) {
                logger.warn('LLM trả về JSON không hợp lệ, dùng câu hỏi gốc', { responseText });
            }

            logger.info('Query optimized for RAG', {
                raw: rawQuery,
                rewritten: standaloneQuestion,
                used_history: usedHistory
            });

            return {
                rewritten_query: standaloneQuestion,
            };

        } catch (error) {
            logger.error('Error during rewrite', { error: String(error) });
            return { rewritten_query: rawQuery }; // Fallback an toàn
        }
    };
}