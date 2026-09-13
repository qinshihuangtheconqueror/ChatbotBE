import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { SkillDefinition } from './registry';
import { StateAnnotation, Citation } from '../graph/graph/state';
import { createLogger } from '@/common/logger/logger';
import { envConfig } from '@/common/config/env.config';
import { resolveSchoolLabel, sanitizeLabels, toGatewayLabels } from './school-labels';

const logger = createLogger('PolicySearchSkill');

export function createPolicySearchSkill(): SkillDefinition {
    return {
        name: 'policy_search',
        description: 'Tìm kiếm quy chế, chính sách HUST trong Milvus knowledge base',

        async run(
            state: typeof StateAnnotation.State & { query_labels?: string[] },
            _config?: LangGraphRunnableConfig,
        ): Promise<Partial<typeof StateAnnotation.State>> {
            const lastMsg = state.messages[state.messages.length - 1];
            const rawQuery = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

            // HyDE đã tắt (node.rewrite.ts) — dùng rewritten_query trực tiếp
            const query = state.rewritten_query || rawQuery;

            if (!query) {
                return { skill_results: [{ skill: 'policy_search', success: false, error: 'Empty query' }] };
            }

            // ── Gộp labels để search cả tài liệu RIÊNG của trường/khoa ────────────
            // (1) Trường/khoa của chính sinh viên — LUÔN có nếu đã đăng nhập.
            //     Lấy từ student_context.school (là TÊN, cần đổi sang mã label).
            // (2) Trường/khoa mà sinh viên NHẮC TỚI trong câu hỏi — do ReAct (LLM)
            //     trích xuất sẵn thành mã label và truyền qua state.query_labels.
            // Tài liệu nhãn 'all' luôn được Gateway tìm tới nên KHÔNG cần truyền.
            const studentLabel = resolveSchoolLabel(state.student_context?.school);
            const queryLabels = sanitizeLabels(state.query_labels);
            // toGatewayLabels: hạ nhãn chưa đăng ký trên Gateway (vd 'sep') về 'all',
            // nếu không Gateway trả 400 và policy_search chết âm thầm.
            const labels = toGatewayLabels(sanitizeLabels([studentLabel, ...queryLabels]));


            try {
                // 1. Gọi sang Python Retriever API
                const response = await fetch(envConfig.RETRIEVER_API, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': envConfig.RETRIEVER_TOKEN.startsWith('Bearer ') 
                        ? envConfig.RETRIEVER_TOKEN 
                        : `Bearer ${envConfig.RETRIEVER_TOKEN}`
                },
                body: JSON.stringify({
                    query: query,
                    top_k: envConfig.TOP_K_SEARCH,
                    top_k_rerank: envConfig.TOP_K_RERANK,
                    bot_id: envConfig.RETRIEVER_BOT_ID,   // Gateway resolves to the KB's active version (KMS-controlled)
                    rerank: envConfig.NEED_RERANK,
                    rewrite: envConfig.NEED_REWRITE,
                    // Chỉ truyền `labels` khi có; rỗng -> Gateway không filter label (search toàn bộ KB)
                    ...(labels.length ? { labels } : {}),
                })
            });

                if (!response.ok) {
                    throw new Error(`Retriever API failed with status: ${response.status}`);
                }

                const searchData = await response.json();

                // 2. Map dữ liệu từ API Python trả về thành format Chunk & Citation của LangGraph
                // (Đoạn này cần xem cấu trúc JSON của Python API để map cho đúng)
                const chunks = searchData.results.map((r: any, i: number) => ({
                    context: r.text, 
                    title: r.title,
                    post_date: r.post_date,
                    link: r.link,
                    score: r.score,
                    anchor: `C${i + 1}`,
                }));

                const citations: Citation[] = chunks.map((c: any, i: number) => ({
                    source: 'kb' as const,
                    id: `kb-${i}`,
                    title: c.title,
                    link: c.link,
                    anchor: c.anchor,
                }));
                logger.info('Policy search done', {
                    query: query.substring(0, 60),
                    labels,
                    found: chunks.length,
                    mode: 'direct', // HyDE đã tắt
                });
                const llm_instruction = `[QUY TẮC TRÍCH DẪN TÀI LIỆU — CÓ ĐIỀU KIỆN]:
ĐIỀU KIỆN ÁP DỤNG: Bạn CHỈ trích dẫn khi câu trả lời THỰC SỰ dùng tới nội dung của (các) tài liệu dưới đây.
- Nếu tài liệu tra về KHÔNG liên quan tới câu hỏi, hoặc bạn KHÔNG dùng tới nó (VD: câu xã giao, câu chỉ cần dữ liệu cá nhân, hoặc tài liệu lạc đề) → KHÔNG tạo mục "Tài liệu tham khảo", KHÔNG chèn link gượng ép. Tránh trích dẫn thừa thãi.
- Nếu CÓ dùng tới tài liệu → BẮT BUỘC trích dẫn ĐẦY ĐỦ theo 2 việc sau (đây là điểm mạnh cần giữ, không được bỏ):
**A. Trích dẫn trong bài (Inline):** Nếu trong nội dung quy chế có sẵn các link Markdown (ví dụ: [xem tại đây](https...)), hãy GIỮ NGUYÊN định dạng Markdown đó trong thân câu trả lời.
**B. Tạo mục "Tài liệu tham khảo" ở cuối câu trả lời:**
Xuống dòng và tạo mục "**Tài liệu tham khảo:**", liệt kê ĐÚNG các tài liệu gốc ĐÃ DÙNG (KHÔNG liệt kê tài liệu không dùng tới), KHÔNG liệt kê trùng lặp 1 tài liệu.
Bạn phải đọc các trường "Tiêu đề" và "Nguồn" được cung cấp trong NGỮ CẢNH để tạo danh sách tài liệu.
- Phải dùng đúng cú pháp Markdown: \`- [BÊ NGUYÊN VĂN DÒNG "Tiêu đề" Ở ĐẦU NGỮ CẢNH SỬ DỤNG CHO CÂU TRẢ LỜI VÀO ĐÂY](URL_liên_kết)\`, CẤM KHÔNG ĐƯỢC THAY ĐỔI HAY BỔ SUNG NỘI DUNG, GIỮ NGUYÊN CẤU TRÚC [Tiêu đề](URL) như trong NGỮ CẢNH.
- **Ví dụ CHUẨN:** - [Quy chế đào tạo đại học chính quy (Ban hành năm 2021)](https://hust.edu.vn/...)
  - [Hướng dẫn đăng ký lớp sinh viên](https://ctt.hust.edu.vn/...)
- **Ví dụ SAI:** - [Link](https://...)
  - [Tại đây](https://...)
  - [Nguồn 1](https://...)`;
  
                return {
                    skill_results: [{ skill: 'policy_search', success: true, data: { chunks }, llm_instruction: llm_instruction }],
                    citations,
                };
            } catch (e) {
                const errMsg = (e as Error).message;
                logger.error('Milvus search failed', e);
                return {
                    skill_results: [{ skill: 'policy_search', success: false, error: errMsg }],
                };
            }
        },
    };
}
