import { HumanMessage, AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { LlmFactory } from '../../llm/llm.factory';
import { SkillRegistry } from '../../skills/registry';
import { StateAnnotation } from '../graph/state';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { buildSkillTools } from './react.tools';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('ReActAgent');

const REACT_SYSTEM_PROMPT = `Bạn là BỘ NÃO TÌM KIẾM (Researcher) của hệ thống HustVA.
Nhiệm vụ: Phân tích câu hỏi, gọi CÔNG CỤ (tool) để thu thập tối đa DỮ LIỆU. 
Bạn KHÔNG PHẢI là người viết câu trả lời cuối cùng cho sinh viên (việc đó do node Compose đảm nhận).

## Nguyên tắc hoạt động:
1. 🔒 LƯỚI AN TOÀN BẮT BUỘC — "policy_search" (QUY TẮC CỨNG, KHÔNG NGOẠI LỆ):
   - Ở LƯỢT 1, DÙ bạn chọn (các) công cụ chuyên biệt nào, bạn LUÔN PHẢI gọi KÈM "policy_search" SONG SONG trong CÙNG lượt đó.
   - Ngoại lệ DUY NHẤT: nếu công cụ duy nhất cần dùng vốn đã chính là policy_search thì chỉ gọi nó.
   - Lý do: policy_search rất rẻ và là nguồn tra cứu tài liệu/quy chế/thông báo BAO TRÙM NHẤT; bỏ sót nó thường khiến câu trả lời thiếu căn cứ (VD: hỏi "cơ hội thực tập của khoa này" mà chỉ gọi company_topics thì sẽ thiếu thông tin chung).
   - Khi gọi policy_search: BẮT BUỘC tự VIẾT LẠI câu truy vấn (rewritten_query) thật rõ ràng, đầy đủ ngữ cảnh; ĐỒNG THỜI nếu câu hỏi có nhắc tới (các) trường/khoa cụ thể (VD: "Trường Điện", "Khoa Toán-Tin", "SOICT"...) thì phải điền thêm tham số "keyword" là (các) mã label tương ứng — nếu không nhắc tới trường/khoa nào thì bỏ trống "keyword".
   - VÍ DỤ GỌI SONG SONG (lượt 1): "cơ hội thực tập của khoa này" -> [company_topics, policy_search]; "GPA của em và quy chế cảnh báo học vụ" -> [academic, policy_search]; "đề tài của thầy A và quy định làm đồ án" -> [teacher_topics, policy_search].
2. CHỌN CÔNG CỤ CHUYÊN BIỆT CHO CHÍNH XÁC: Đừng ngại gọi nhiều công cụ song song trong cùng một lượt để thu thập tối đa dữ liệu. NHƯNG chỉ gọi một công cụ chuyên biệt (student_info, grade_lookup, academic, course_info, program, schedule, teacher_topics, company_topics) khi câu hỏi KHỚP RÕ RÀNG với mô tả & phạm vi của nó. Nếu phân vân, hoặc câu hỏi mang tính tra cứu tài liệu/thông tin chung, ĐỪNG cố ép vào một công cụ cá nhân — cứ để "policy_search" (vốn đã luôn được gọi) đảm nhiệm. Gọi nhầm công cụ cá nhân (đặc biệt student_info, grade_lookup) gây nhiễu dữ liệu cho câu trả lời.
3. ĐÁNH GIÁ KẾT QUẢ (Lượt 2): Khi nhận được kết quả từ công cụ, BẮT BUỘC KIỂM TRA CHÉO với câu hỏi gốc.
   - Nếu THIẾU thông tin (VD: Hỏi so sánh A và B, nhưng tool chỉ trả về A): BẮT BUỘC gọi công cụ một lần nữa với từ khóa mới tập trung vào B.
   - Nếu dữ liệu rỗng: Đổi công cụ khác hoặc đổi từ khóa tìm kiếm rộng hơn.
4. QUY TẮC DỪNG VÀ CẤM TRẢ LỜI:
   - Khi bạn đánh giá dữ liệu thu thập đã ĐỦ để trả lời câu hỏi gốc, TUYỆT ĐỐI KHÔNG được sinh ra văn bản trả lời sinh viên.
   - Để kết thúc, bạn CHỈ CẦN in ra một cụm từ duy nhất: "[DONE_SEARCH]". Không giải thích, không thưa gửi.
5. SUY LUẬN NGỮ CẢNH: Đọc [LỊCH SỬ HỘI THOẠI] để tự hiểu các đại từ ("môn đó", "kỳ trước") và trích xuất đúng tham số.`;

export type ReActResult = {
    skillResults: Array<{ skill: string; success: boolean; data?: Record<string, unknown>; error?: string }>;
    draftAnswer: string;
    toolsUsed: string[];
    iterations: number;
    tokenUsage: { input_tokens: number; output_tokens: number; total_tokens: number };
    citations: Array<any>;
};

export async function runReActAgent(
    state: typeof StateAnnotation.State,
    llmFactory: LlmFactory,
    registry: SkillRegistry,
    allowedTools: string[],
    config?: LangGraphRunnableConfig,
): Promise<ReActResult> {
    const query = state.rewritten_query ||
        (typeof state.messages?.at?.(-1)?.content === 'string'
            ? (state.messages.at(-1)!.content as string)
            : '');

    logger.info('ReActAgent starting', { query: query.slice(0, 80), allowedTools });

    const capturedPatches: Partial<typeof StateAnnotation.State>[] = [];
    
    let tools = buildSkillTools(registry, state, config, (patch) => {
        capturedPatches.push(patch);
    });

    // Lọc tool theo danh sách từ ReactNode
    tools = tools.filter(t => allowedTools.includes(t.name));

    const baseModel = llmFactory.getModel('react'); 
    const model = tools.length > 0 ? baseModel.bindTools!(tools) : baseModel;
    
    const toolsUsed: string[] = [];
    const tokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    
    const recentMessages = state.messages.slice(Math.max(0, state.messages.length - 5), -1);
    const messages: BaseMessage[] = [];

    let historyContext = "";
    if (recentMessages.length > 0) {
        historyContext = "[LỊCH SỬ HỘI THOẠI GẦN ĐÂY ĐỂ BẠN THAM KHẢO]:\n" + 
            recentMessages.map(m => `${m._getType() === 'human' ? 'Sinh viên' : 'HustVA'}: ${m.content}`).join('\n') + "\n\n";
    }

    messages.push(new HumanMessage(`${historyContext}[CÂU HỎI HIỆN TẠI]: ${query}`));

    // Các biến lưu trữ toàn cục cho toàn bộ quá trình ReAct
    let draftAnswer = '';
    
    let iterations = 0;
    const MAX_ITERATIONS = 2; // 🔥 OPTION 2: Cho phép Agent suy nghĩ tối đa 3 vòng

    // 🔥 VÒNG LẶP REACT CHÍNH THỨC
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        logger.info(`ReAct Loop [${iterations}/${MAX_ITERATIONS}] Started`);

        let aiResponse: AIMessage | null = null;
        let retryCount = 0;
        const MAX_RETRIES = 3;

        // Vòng lặp nhỏ này chỉ để xử lý lỗi mạng/timeout của LLM (giữ nguyên của bạn)
        while (retryCount < MAX_RETRIES) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => { controller.abort(); }, 30000); 

            try {
                aiResponse = await model.invoke(
                    [ { role: 'system', content: REACT_SYSTEM_PROMPT }, ...messages ],
                    { signal: controller.signal } 
                ) as AIMessage;
                
                clearTimeout(timeoutId);
                break; 
            } catch (err: any) {
                // ... (Xử lý retry timeout như code cũ)
                clearTimeout(timeoutId);
                retryCount++;
                logger.warn(`⚠️ [ReAct Retry LLM] Lần ${retryCount}/${MAX_RETRIES}: ${err?.message}`);
                if (retryCount >= MAX_RETRIES) {
                    return { skillResults: [], draftAnswer: '', toolsUsed: [], iterations, tokenUsage, citations: [] };
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Cập nhật Token Usage
        if (aiResponse?.usage_metadata) {
            tokenUsage.input_tokens += aiResponse.usage_metadata.input_tokens || 0;
            tokenUsage.output_tokens += aiResponse.usage_metadata.output_tokens || 0;
            tokenUsage.total_tokens += aiResponse.usage_metadata.total_tokens || 0;
        }

        // 🔥 LƯU LẠI LỜI NÓI CỦA AI ĐỂ DUY TRÌ NGỮ CẢNH CHO VÒNG SAU
        if (aiResponse) {
            messages.push(aiResponse);
        }

        const toolCalls = aiResponse?.tool_calls ?? [];

        // ĐIỂM DỪNG: Nếu AI không gọi tool nào nữa -> Chốt câu trả lời cuối cùng
        if (toolCalls.length === 0) {
            const aiText = aiResponse?.content 
                ? (typeof aiResponse.content === 'string' ? aiResponse.content : JSON.stringify(aiResponse.content))
                : '';

            if (aiText.includes('[DONE_SEARCH]')) {
                logger.info('ReAct: LLM signaled [DONE_SEARCH] - Data collection is sufficient. Breaking loop.');
            } else {
                logger.info('ReAct: LLM stopped calling tools but generated text instead of [DONE_SEARCH]. Forcing break.');
            }
            
            // Ép biến draftAnswer thành rỗng để đảm bảo sự sạch sẽ (vì Compose sẽ lo phần Text)
            draftAnswer = ''; 
            break; 
        }

        logger.info('ReAct: Executing tool calls', { tools: toolCalls.map(tc => tc.name) });
        const toolResultMessages: ToolMessage[] = [];

        await Promise.allSettled(
            toolCalls.map(async (tc) => {
                const matchedTool = tools.find(t => t.name === tc.name);
                let toolResultString = "";

                if (matchedTool) {
                    toolsUsed.push(tc.name);
                    try {
                        // Gọi tool (hàm này đồng thời đẩy dữ liệu vào capturedPatches qua callback)
                        const rawResult = await matchedTool.invoke(tc.args ?? {});
                        toolResultString = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
                        
                        // Nếu tool trả về rỗng, hướng dẫn Agent gọi tool khác
                        if (!toolResultString || toolResultString === "{}" || toolResultString === "[]") {
                            toolResultString = "Không tìm thấy dữ liệu. Hãy cân nhắc sử dụng công cụ policy_search nếu câu hỏi mang tính chất tìm kiếm quy định.";
                        }
                    } catch (e: any) {
                        logger.error(`Error invoking tool ${tc.name}:`, e);
                        toolResultString = `Lỗi hệ thống khi gọi tool: ${e.message}. Hãy thử sử dụng công cụ khác như policy_search.`;
                    }
                } else {
                    toolResultString = `Công cụ ${tc.name} không khả dụng.`;
                }

                // Đóng gói kết quả thành ToolMessage chuẩn của LangChain
                toolResultMessages.push(new ToolMessage({
                    tool_call_id: tc.id!,
                    name: tc.name,
                    content: toolResultString
                }));
            })
        );

        // Nạp kết quả vào lịch sử để LLM đọc ở vòng lặp tiếp theo
        messages.push(...toolResultMessages);
    } // End of While Loop

    // 🔒 LƯỚI AN TOÀN (FALLBACK): policy_search rẻ (~0.8s) nhưng cực hữu ích.
    // Prompt đã ÉP LLM gọi policy_search song song, nhưng LLM không phải lúc nào cũng tuân thủ
    // 100%. Nếu cả vòng lặp mà policy_search VẪN chưa từng chạy, ta chủ động chạy nó 1 lần bằng
    // rewritten_query toàn cục (đã được node.rewrite chuẩn hoá). Trường/khoa của SV vẫn được skill
    // tự thêm qua student_context; chỉ thiếu "keyword" trích từ câu hỏi (hiếm) — có còn hơn không.
    if (
        registry.has('policy_search') &&
        allowedTools.includes('policy_search') &&
        !toolsUsed.includes('policy_search') &&
        query
    ) {
        logger.warn('ReAct: LLM không tự gọi policy_search dù prompt đã ép -> kích hoạt FALLBACK chạy trực tiếp.');
        try {
            const fallbackState = { ...state, rewritten_query: query, query_labels: [] };
            const patch = await registry.get('policy_search')!.run(fallbackState, config);
            capturedPatches.push(patch);
            toolsUsed.push('policy_search');
        } catch (e: any) {
            logger.error('ReAct: policy_search fallback thất bại', { error: e?.message });
        }
    }

    const finalSkillResults = capturedPatches.flatMap(p => p.skill_results || []);

    return {
        skillResults: finalSkillResults, 
        draftAnswer,
        toolsUsed: [...new Set(toolsUsed)], // Loại bỏ tên tool bị trùng lặp
        iterations,
        tokenUsage,
        citations: [],
    };
}