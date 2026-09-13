import { tool, StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { SkillRegistry } from '../../skills/registry';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation, SkillResult } from '../graph/state';
import { createLogger } from '@/common/logger/logger';
import { KNOWN_LABELS } from '../../skills/school-labels';

const logger = createLogger('ReActTools');

// ─── Typed helpers ────────────────────────────────────────────────────────────

/** Extract the first SkillResult from a state patch returned by skill.run() */
function firstResult(patch: Partial<typeof StateAnnotation.State>): SkillResult | undefined {
    return patch.skill_results?.[0];
}

/** * Helper tối thượng: Format kết quả từ Skill thành chuỗi cho LLM đọc.
 * Ưu tiên dùng llm_instruction, nếu không có thì stringify data.
 */
function formatToolOutput(toolName: string, sr: SkillResult | undefined): string {
    if (!sr) return `[${toolName}] Tool không trả về kết quả.`;
    if (!sr.success) return `[${toolName}] Lỗi: ${sr.error ?? 'Unknown'}`;
    
    let output = `[Kết quả từ ${toolName}]`;
    if (sr.llm_instruction) {
        output += `\n>>> CHỈ THỊ CỦA HỆ THỐNG:\n${sr.llm_instruction}`;
    }
    if (sr.data) {
        // Cắt bớt nếu data quá to để tránh tràn token của Agent
        output += `\n>>> DỮ LIỆU:\n${JSON.stringify(sr.data).slice(0, 3000)}`;
    }
    return output;
}

/**
 * Factory: Bọc 9 Skill thành 9 LangChain Tools cho ReAct Agent.
 * MÔ TẢ ĐƯỢC VIẾT TỐI ƯU ĐỂ LLM PHÂN BIỆT RÕ RÀNG, KHÔNG BỊ CHỒNG CHÉO.
 */
export function buildSkillTools(
    registry: SkillRegistry,
    state: typeof StateAnnotation.State,
    config?: LangGraphRunnableConfig,
    onSkillRun?: (patch: Partial<typeof StateAnnotation.State>) => void
): StructuredTool[] {
    const tools: StructuredTool[] = [];

    // ── 1. Student info ─────────────────────────────────────────────────────────
    if (registry.has('student_info')) {
        tools.push(tool(
            async () => {
                const patch = await registry.get('student_info')!.run(state, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('student_info', firstResult(patch));
            },
            {
                name: 'student_info',
                description: 'Tra cứu HỒ SƠ CÁ NHÂN của CHÍNH sinh viên: họ tên, MSSV, lớp, ngành/chương trình, giáo viên hướng dẫn, và hồ sơ mở rộng (đồ án bản thân, khen thưởng - kỷ luật, học bổng đã nhận, đề tài NCKH của bản thân). CHỈ dùng khi sinh viên hỏi TRỰC TIẾP về thông tin lý lịch/hồ sơ của BẢN THÂN. KHÔNG dùng để: tra điểm số (grade_lookup), CPA/GPA - cảnh báo học vụ (academic), lịch học/thi (schedule), khung chương trình đào tạo (program), hay mọi câu hỏi về quy định/thủ tục/thông tin chung (policy_search). Nếu câu hỏi KHÔNG rõ ràng là hỏi về hồ sơ bản thân thì TUYỆT ĐỐI KHÔNG chọn công cụ này.',
                schema: z.object({}),
            }
        ));
    }

    // ── 2. Academic ─────────────────────────────────────────────────────────────
    if (registry.has('academic')) {
        tools.push(tool(
            async () => {
                const patch = await registry.get('academic')!.run(state, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('academic', firstResult(patch));
            },
            {
                name: 'academic',
                description: 'Xem TỔNG QUAN kết quả học tập: CPA, GPA, mức cảnh báo học vụ, tổng tín chỉ nợ, tổng tín chỉ tích lũy. CHỈ dùng khi sinh viên hỏi về tình hình học tập toàn khóa hoặc tổng kết kỳ. TUYỆT ĐỐI KHÔNG dùng để tra cứu điểm của từng môn học cụ thể (dùng grade_lookup), KHÔNG dùng để tư vấn đăng ký môn học / xem khung chương trình (dùng program).',
                schema: z.object({}),
            }
        ));
    }

    // ── 3. Grade Lookup ─────────────────────────────────────────────────────────
    if (registry.has('grade_lookup')) {
        tools.push(tool(
            async (input) => {
                const localState = { ...state, rewritten_query: input.query };
                const patch = await registry.get('grade_lookup')!.run(localState, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('grade_lookup', firstResult(patch));
            },
            {
                name: 'grade_lookup',
                description: 'Tra cứu ĐIỂM SỐ thực tế (điểm chữ, điểm thành phần, trạng thái qua/trượt) của MỘT HOẶC NHIỀU môn học cụ thể, hoặc lấy toàn bộ BẢNG ĐIỂM CHI TIẾT của một học kỳ. CHỈ dùng khi sinh viên hỏi ĐÍCH DANH về ĐIỂM đã có. KHÔNG dùng để: hỏi CPA/GPA - cảnh báo học vụ tổng quan (academic); xem đặc tả/đề cương/cách tính điểm/tài liệu môn học (course_info); xem khung chương trình đào tạo (program); xem lịch học/lịch thi (schedule). Nếu câu hỏi KHÔNG trực tiếp về điểm thì TUYỆT ĐỐI KHÔNG chọn công cụ này.',
                schema: z.object({
                  query: z.string().describe('Từ khóa trích xuất từ câu hỏi: Có thể là tên/mã của các môn học (VD: "Giải tích 1", "MI1111", "THĐC"), hoặc mốc thời gian học kỳ (VD: "kỳ 20231", "kỳ vừa rồi"). Truyền nguyên văn yêu cầu cốt lõi, nếu yêu cầu chung không rõ ràng ví dụ "Cho tôi bảng điểm", hãy mặc định trả về kì gần nhất bằng cách thêm chữ "kì trước" vào ("Cho tôi bảng điểm kì trước").'),
                }),
            }
        ));
    }

    // ── 4. Course Info ──────────────────────────────────────────────────────────
    if (registry.has('course_info')) {
        tools.push(tool(
            async (input) => {
                const localState = { ...state, rewritten_query: input.query };
                const patch = await registry.get('course_info')!.run(localState, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('course_info', firstResult(patch));
            },
            {
                name: 'course_info',
                description: 'Tra cứu ĐẶC TẢ của MỘT môn học: trọng số điểm (quá trình/cuối kỳ), cách tính điểm, tài liệu học tập, đề cương chi tiết, slide bài giảng, học phần điều kiện tiên quyết/song hành, giảng viên phụ trách môn. CHỈ dùng cho môn học có trong chương trình đào tạo. KHÔNG dùng để xem ĐIỂM thực tế của sinh viên (grade_lookup) hay toàn bộ khung chương trình đào tạo (program).',
                schema: z.object({
                    query: z.string().describe('Chỉ trích xuất tên môn (có thể bị viết tắt) hoặc mã môn học cần tra cứu (VD: "IT1110", "Giải tích 2", "CSDL").'),
                }),
            }
        ));
    }

    // ── 5. Program ──────────────────────────────────────────────────────────────
    if (registry.has('program')) {
        tools.push(tool(
            async () => {
                const patch = await registry.get('program')!.run(state, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('program', firstResult(patch));
            },
            {
                name: 'program',
                description: 'Tra cứu toàn bộ KHUNG CHƯƠNG TRÌNH ĐÀO TẠO, chi tiết các module trong chương trình CỦA SINH VIÊN. Dùng khi sinh viên cần xem chương trình đào tạo, tư vấn đăng ký môn học, kiểm tra tiến độ, thống kê các môn đang nợ, hoặc phân tích chiến lược học cải thiện để nâng hạng bằng. KHÔNG dùng để xem điểm số (grade_lookup/academic) hay đặc tả chi tiết MỘT môn đơn lẻ (course_info). Tránh gọi nhầm tới khi bị hỏi về một số chương trình đặc biệt không phải chương trình đào tạo.',
                schema: z.object({}),
            }
        ));
    }

    // ── 6. Schedule ─────────────────────────────────────────────────────────────
    if (registry.has('schedule')) {
        tools.push(tool(
            async () => {
                const patch = await registry.get('schedule')!.run(state, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('schedule', firstResult(patch));
            },
            {
                name: 'schedule',
                description: 'Tra cứu thời khóa biểu, lịch học, lịch thi, phòng học, hoặc thông tin tuần học hiện tại của sinh viên. Có thể dùng để hỏi lịch học/lịch thi của kỳ học trước đó',
                schema: z.object({
                    query: z.string().describe('Mốc thời gian sinh viên muốn xem (VD: "tuần này", "hôm nay", "kỳ trước", "20231"). Nếu sinh viên hỏi lịch chung chung không có mốc thời gian, hãy truyền chuỗi rỗng "".'),
                }),
            }
        ));
    }

    // ── 7. Teacher Topics ───────────────────────────────────────────────────────
    if (registry.has('teacher_topics')) {
        tools.push(tool(
            async (input) => {
                const localState = { ...state, extracted_teacher_name: input.teacher_name };
                const patch = await registry.get('teacher_topics')!.run(localState, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('teacher_topics', firstResult(patch));
            },
            {
                name: 'teacher_topics',
                description: 'Tìm thông tin cá nhân, định hướng nghiên cứu, hoặc danh sách đề tài NCKH/Đồ án tốt nghiệp do MỘT GIẢNG VIÊN cụ thể hướng dẫn. CHỈ dùng khi câu hỏi gắn với một giảng viên (nêu tên, hoặc "giảng viên hướng dẫn của em"). KHÔNG dùng cho câu hỏi chung về quy định/thủ tục làm đồ án, NCKH (việc đó dùng policy_search).',
                schema: z.object({
                    teacher_name: z.string().describe('Tên giảng viên cần tìm. BẮT BUỘC LOẠI BỎ mọi từ xưng hô, học hàm, học vị (thầy, cô, pgs, ts, gv). VD: "cho em xin thông tin cô trang" -> "trang", "thầy Nguyễn Văn A" -> "Nguyễn Văn A".'),
                }),
            }
        ));
    }

    // ── 8. Company Topics ───────────────────────────────────────────────────────
    if (registry.has('company_topics')) {
        tools.push(tool(
            async (input) => {
                const localState = { ...state, extracted_company_name: input.company_name };
                const patch = await await registry.get('company_topics')!.run(localState, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('company_topics', firstResult(patch));
            },
            {
                name: 'company_topics',
                description: 'Tìm danh sách đề tài Đồ án/Thực tập do MỘT DOANH NGHIỆP/CÔNG TY cụ thể (có hợp tác với trường) cung cấp. CHỈ dùng khi sinh viên nêu đích danh tên doanh nghiệp/công ty, HOẶC hỏi rõ về "đề tài/thực tập do doanh nghiệp cung cấp". TUYỆT ĐỐI KHÔNG dùng cho câu hỏi chung về "cơ hội thực tập", "thực tập của khoa/trường", quy định/thủ tục/chính sách thực tập — những trường hợp đó dùng policy_search.',
                schema: z.object({
                    company_name: z.string().describe('Tên doanh nghiệp cần tìm. BẮT BUỘC LOẠI BỎ các từ khóa loại hình công ty (công ty, tập đoàn, doanh nghiệp, cổ phần, TNHH). VD: "công ty viettel telecom" -> "viettel telecom", "tập đoàn FPT" -> "FPT".'),
                }),
            }
        ));
    }

    // ── 9. Policy Search (RAG) ──────────────────────────────────────────────────
    if (registry.has('policy_search')) {
        tools.push(tool(
            async (input) => {
                const localState = {
                    ...state,
                    rewritten_query: input.query,
                    // Mã trường/khoa LLM trích xuất được từ câu hỏi (có thể rỗng).
                    // Skill sẽ tự gộp thêm trường/khoa của chính sinh viên.
                    query_labels: input.keyword ?? [],
                };
                const patch = await registry.get('policy_search')!.run(localState, config);
                if (onSkillRun) onSkillRun(patch);
                return formatToolOutput('policy_search', firstResult(patch));
            },
            {
                name: 'policy_search',
                description: 'Công cụ tìm kiếm tài liệu. Dùng để tra cứu BẤT KỲ quy chế đào tạo, thủ tục hành chính, quy định học phí, học bổng, KTX, vé gửi xe, hoặc các thông báo sự kiện chung của nhà trường.',
                schema: z.object({
                    query: z.string().describe('Nhiệm vụ của bạn: Hãy phân tích yêu cầu của sinh viên và VIẾT LẠI thành một câu truy vấn tìm kiếm (Search Query) thật rõ ràng, đầy đủ ngữ cảnh để công cụ tìm kiếm hoạt động tốt nhất. (VD: "vé gửi xe nạp kiểu gì" -> "hướng dẫn thủ tục nạp tiền vé gửi xe tháng").'),
                    keyword: z.array(z.enum(KNOWN_LABELS)).optional().describe(
                        `Mã trường/khoa (label) được NHẮC TỚI trong câu hỏi của sinh viên.
- CHỈ điền khi sinh viên CHỦ ĐỘNG nhắc tới một/nhiều trường/khoa CỤ THỂ. Nếu hỏi chung chung, KHÔNG nhắc tới trường/khoa nào thì BỎ TRỐNG (không trả về trường này).
- Nếu nhắc tới NHIỀU trường/khoa thì liệt kê TẤT CẢ.
Quy tắc ánh xạ TÊN -> MÃ:
  • Khoa Toán - Tin -> 'fami'
  • Khoa Khoa học (và Công nghệ) Giáo dục -> 'fed'
  • Trường Hóa và Khoa học sự sống -> 'scls'
  • Trường Điện - Điện tử -> 'seee'
  • Trường Kinh tế -> 'sem'
  • Trường Cơ khí -> 'sme'
  • Trường Vật liệu -> 'smse'
  • Khoa Ngoại ngữ -> 'sofl'
  • Trường Công nghệ Thông tin và Truyền thông (CNTT&TT / SOICT) -> 'soict'
  • Khoa Vật lý Kỹ thuật -> 'sep'
VD: "học bổng của trường điện" -> ["seee"]; "so sánh quy định trường cơ khí với trường kinh tế" -> ["sme","sem"]; "quy chế đào tạo chung của trường" -> bỏ trống.`,
                    ),
                }),
            }
        ));
    }

    logger.info(`Built ${tools.length} ReAct tools from registry`);
    return tools;
}