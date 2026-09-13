import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from './state';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('IngressNode');

/**
 *  Matches an 8-digit Vietnamese student ID (MSSV), optionally preceded by a label
 *  like "sinh viên", "MSSV", "msv", "sv", "mã số", etc.
 *  Captures group 1 = the 8-digit ID.
 */
const MSSV_RE = /\b(?:sinh\s*vi[eê]n|mssv|msv|m[aã]\s*s[oố]|sv)\s+(\d{8})\b|\b(\d{8})\b/gi;

/**
 * Sanitise a user message so it never references another student's MSSV.
 *
 * Strategy:
 *  1. Find every 8-digit number in the message that looks like an MSSV.
 *  2. If an MSSV differs from the authenticated student's own MSSV → replace
 *     the whole match with a neutral phrase ("sinh viên của em") so the agent
 *     continues to work but cannot query foreign data.
 *  3. If the MSSV IS the authenticated student's own → leave it untouched.
 *
 * This prevents prompt-injection attacks like:
 *   "cho mình xem điểm sinh viên 20229999"
 *   "điểm của sv 20221234 là bao nhiêu?"
 */
function sanitiseMessage(message: string, ownStudentId: string): { sanitised: string; blocked: boolean } {
    let blocked = false;

    const sanitised = message.replace(MSSV_RE, (match, g1, g2) => {
        const candidateId: string = g1 || g2;
        // Ignore if it's the user's own MSSV
        if (candidateId === ownStudentId) return match;
        // Foreign MSSV detected → replace
        blocked = true;
        return match.includes(candidateId)
            ? match.replace(candidateId, '[MSSV ẩn]')
            : match;
    });

    return { sanitised, blocked };
}

/** ingress: Reset ALL transient fields each turn — including student_context to prevent cross-turn bleed.
 *  Also sanitises the incoming message to strip foreign MSSVs (privacy guard).
 */
export async function ingressNode(
    state: typeof StateAnnotation.State,
    config?: LangGraphRunnableConfig,
): Promise<Partial<typeof StateAnnotation.State>> {
    const ownStudentId = config?.configurable?.student_id as string | undefined;
    const messages = state.messages ?? [];

    // Sanitise the last user message if we have an authenticated student_id
    let sanitisedMsg: any = null;
    let blockedByPrivacy = false;

    if (ownStudentId && messages.length > 0) {
        const lastIdx = messages.length - 1;
        const last = messages[lastIdx];
        const content = typeof last?.content === 'string' ? last.content : '';

        if (content) {
            const { sanitised, blocked } = sanitiseMessage(content, ownStudentId);
            if (blocked) {
                blockedByPrivacy = true;
                logger.warn('[Privacy] Blocked foreign MSSV query', {
                    original: content.slice(0, 100),
                    sanitised: sanitised.slice(0, 100),
                    studentId: ownStudentId,
                });

                // Use sanitised message so rewriteNode cannot process foreign MSSV
                sanitisedMsg = Object.assign(
                    Object.create(Object.getPrototypeOf(last)), 
                    last, 
                    { content: sanitised, id: last.id } // <--- Giữ lại last.id
                );
            }
        }
    }

    if (blockedByPrivacy && sanitisedMsg) {
        return {
            messages: [sanitisedMsg], 
            selected_skills: [], skill_results: [], citations: [], student_context: null,
            rewritten_query: sanitisedMsg.content, routing: { intent: 'privacy_blocked' },
            draft_answer: '__PRIVACY_BLOCKED__',
            final_text: '⚠️ Bạn không có quyền xem thông tin của sinh viên khác. Hệ thống chỉ cung cấp thông tin cho chính bạn.',
            error: null,
        };
    }

    // không trả về message nữa tránh duplicate vì đã có sẵn ở agent-facade rồi
    return {
        selected_skills: [],
        skill_results: [],
        citations: [],
        student_context: null,
        rewritten_query: '',
        routing: null,
        draft_answer: null,
        final_text: null,
        error: null,
    };
}
