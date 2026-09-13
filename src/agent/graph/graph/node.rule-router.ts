import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from './state';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('RuleRouterNode');

// ─── Rule definitions ─────────────────────────────────────────────────────────

interface RoutingRule {
    name: string;
    pattern: RegExp;
    skills: string[]; // Rỗng [] ám chỉ chitchat
}

/**
 * LUẬT ĐIỀU HƯỚNG (Gom nhóm - Gom tất cả các match)
 * Không còn First Match Wins nữa. Ta sẽ quét qua toàn bộ để tìm tất cả các skill có khả năng.
 */
const RULES: RoutingRule[] = [
    // ── 0. Giao tiếp cơ bản ────────────────────────────────────
    {
        name: 'chitchat_basic',
        pattern: /^(chào|hi|hello|alo|cảm ơn|thanks|tạm biệt|bye|khỏe không)\b/i,
        skills: ['chitchat'], // Giờ ta gán rõ là chitchat để React Node xử lý
    },

    // ── 1. Đề cương / Môn tiên quyết (course_info) ──────────────────────────
    {
        name: 'course_info',
        pattern: /đề cương|học phần tiên quyết|môn tiên quyết|học trước|song hành|trọng số (điểm|môn)|tài liệu.*(môn|học phần)|slide bài giảng/i,
        skills: ['course_info'],
    },

    // ── 2. Xem điểm cụ thể môn học (grade_lookup) ────────────────────────────
    {
        name: 'grade_lookup',
        pattern: /điểm (thi|tổng kết|chữ|gk|ck|qt|giữa kỳ|cuối kỳ).*(môn|học phần)|điểm (môn|học phần)/i,
        skills: ['grade_lookup'],
    },

    // ── 3. Tổng kết / Cảnh báo học vụ (academic) ──────────────────────────────
    {
        name: 'academic_summary',
        pattern: /\b(cpa|gpa) (toàn khóa|tích lũy|học kỳ|kỳ|hiện tại)\b|cảnh báo học vụ|tổng kết học tập|tín chỉ đã tích lũy/i,
        skills: ['academic'],
    },

    // ── 4. Lịch học / Lịch thi (schedule) ────────────────────────────────────
    {
        name: 'schedule_tkb_exam',
        pattern: /thời khóa biểu|\btkb\b|lịch (thi|học)|phòng (thi|học)|ca (thi|học)/i,
        skills: ['schedule'],
    },

    // ── 5. Cố vấn Đăng ký / Nâng bằng (program) ──────────────────────────────
    {
        name: 'academic_advisor',
        pattern: /chương trình (đào tạo|học)|ngành (cntt|it|công nghệ thông tin)|curriculum|khung chương trình|môn bắt buộc|môn tự chọn/i,
        skills: ['program'],
    },

    // ── 6. Hồ sơ Sinh viên (student_info) ────────────────────────────────────
    {
        name: 'student_profile',
        pattern: /^(hồ sơ|thông tin cá nhân)|mã số sinh viên\b|\bmssv\b|giáo viên quản lý lớp/i,
        skills: ['student_info'],
    },

    // ── 7. Giảng viên / Đề tài (teacher_topics) ──────────────────────────────
    {
        name: 'teacher_research',
        pattern: /thông tin.*(giảng viên|thầy|cô)|(thầy|cô).*hướng dẫn|đề tài.*(thầy|cô|giảng viên)|(thầy|cô).*nghiên cứu/i,
        skills: ['teacher_topics'],
    },

    // ── 8. Thực tập / Việc làm (company_topics) ──────────────────────────────
    {
        name: 'company_internship',
        pattern: /thực tập|intern|công ty|doanh nghiệp.*hust|tuyển dụng|việc làm|career|hướng nghiệp|xin việc/i,
        skills: ['company_topics'],
    },

    // ── 9. Tra cứu Combo (Policy kết hợp) ────────────────────────────────────
    {
        name: 'academic_policy_combo',
        pattern: /(điểm|gpa|cpa).*(quy định|học bổng|cảnh báo)|cảnh báo.*(quy định|thế nào|điều kiện)/i,
        skills: ['academic', 'policy_search'],
    },
    {
        name: 'schedule_policy_combo',
        pattern: /(lịch thi|lịch học).*(quy định|hoãn|nghỉ|vắng)|(hoãn thi|vắng thi).*(quy định|thủ tục)/i,
        skills: ['schedule', 'policy_search'],
    },

    // ── 10. Chính sách / Quy định chung (policy_search) ──────────────────────
    {
        name: 'policy_general',
        pattern: /quy chế|quy định|học bổng|học phí|miễn giảm|thủ tục|thẻ sinh viên|ký túc xá|chính sách (học|trường)|điều kiện xét (học bổng|miễn)|sự kiện|job fair|hội thảo.*việc|tin tức/i,
        skills: ['policy_search'],
    },
];

// ─── Node ────────────────────────────────────────────────────────────────────

/**
 * Node: Rule-based Scoring
 * Quét Regex qua câu hỏi và đẩy danh sách các skill "match" vào mảng `rule_matches`.
 * Mảng này sau đó sẽ được ReactNode dùng để cộng điểm (Soft Boost).
 */
export async function ruleRouterNode(
    state: typeof StateAnnotation.State,
    _config?: LangGraphRunnableConfig,
): Promise<Partial<typeof StateAnnotation.State>> {
    
    // Privacy Bypass (Nếu vẫn muốn giữ ở đây, ta báo hiệu cho ReAct Node bằng cách gán rule_matches là mảng rỗng)
    if (state.routing?.intent === 'privacy_blocked') {
        logger.info('RuleRouter: Câu hỏi vi phạm Privacy Guard. Không bắt Rule.');
        return { rule_matches: [] }; // Không cộng điểm cho Tool nào hết
    }

    const query = state.rewritten_query ||
        (typeof state.messages?.at?.(-1)?.content === 'string'
            ? (state.messages.at(-1)!.content as string)
            : '');

    if (!query.trim()) {
        logger.warn('RuleRouter: Câu hỏi trống');
        return { rule_matches: [] };
    }

    // 1. Quét tìm TOÀN BỘ các Rule match (Không dừng lại ở cái đầu tiên nữa)
    const matchedSkillsSet = new Set<string>();
    const rulesHit: string[] = [];

    for (const rule of RULES) {
        if (rule.pattern.test(query)) {
            rulesHit.push(rule.name);
            rule.skills.forEach(skill => matchedSkillsSet.add(skill));
        }
    }

    const ruleMatches = Array.from(matchedSkillsSet);

    if (ruleMatches.length > 0) {
        logger.info('RuleRouter: Đã bắt được các từ khóa Regex', {
            rulesHit,
            skillsToBoost: ruleMatches,
            query: query.slice(0, 80),
        });
    } else {
        logger.info('RuleRouter: Không khớp Rule nào. Để Signal Router tự quyết định.');
    }

    // 2. Ghi kết quả vào State. Dừng, KHÔNG CHUYỂN HƯỚNG GRAPH Ở ĐÂY NỮA.
    return {
        rule_matches: ruleMatches, 
        // Ta vẫn có thể ghi lại log metadata vào routing nếu thích
        routing: {
            ...(state.routing ?? {}),
            rule_matched: ruleMatches.length > 0,
        }
    };
}
