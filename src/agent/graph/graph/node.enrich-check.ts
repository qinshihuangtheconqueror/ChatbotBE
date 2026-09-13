import { StateAnnotation } from './state';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('EnrichCheckNode');

const MAX_ITERATIONS = 2;

// ─── Deterministic enrichment rules (Tier 1) ─────────────────────────────────

interface EnrichmentResult {
    needs_more: boolean;
    additional_skills: string[];
    enrichment_queries: Record<string, string>;
}

function detectEnrichmentNeeds(
    state: typeof StateAnnotation.State,
): EnrichmentResult {
    const alreadyRan = new Set(state.skill_results.map((r) => r.skill));
    const additional_skills: string[] = [];
    const enrichment_queries: Record<string, string> = {};

    const hasPolicy = alreadyRan.has('policy_search');
    const hasProgram = alreadyRan.has('program');


    // ── 1. NHÓM QUY TẮC CỨU ĐIỂM (Tự động kích hoạt khi xem Academic) ──
    const academicResult = state.skill_results.find((r) => r.skill === 'academic' && r.success);
    
    if (academicResult && academicResult.data) {
        const data = academicResult.data;
        const warningLevel = Number(data.warningLevel || data.level || 0);
        const cpa = Number(data.cpa || 4.0);

        // EDGE CASE 1: Bị cảnh báo học vụ
        if (warningLevel > 0) {
            // Lấy thêm quy chế để đối chiếu (Tùy chọn, LLM tự chắt lọc)
            if (!hasPolicy) {
                additional_skills.push('policy_search');
                enrichment_queries['policy_search'] = `quy chế cảnh báo học tập mức ${warningLevel}`;
            }
            // Gọi program để lôi môn học ra cứu giá + Ép Prompt cực ngặt
            if (!hasProgram) {
                additional_skills.push('program');
                enrichment_queries['program'] = `(LLM_INSTRUCTION) Sinh viên đang bị cảnh báo mức ${warningLevel}. CHỈ TRẢ LỜI: "Lưu ý đặc biệt, bạn đang bị cảnh báo mức ${warningLevel}, trong thời gian sớm nhất nên đăng ký học lại các môn sau: [Liệt kê môn tạch/điểm F]". TUYỆT ĐỐI KHÔNG tư vấn dài dòng, KHÔNG gợi ý môn học mới.`;
            }
            logger.info(`Enrich: Warning level ${warningLevel} → added policy & program (Cứu nét)`);
        } 
        // EDGE CASE 2: Không bị cảnh báo nhưng CPA dưới 2.0
        else if (cpa > 0 && cpa < 2.0 && !hasProgram) {
            additional_skills.push('program');
            enrichment_queries['program'] = `(LLM_INSTRUCTION) Sinh viên có CPA thấp (${cpa}). TẬP TRUNG tư vấn: Cải thiện điểm các môn D, D+ và ưu tiên học lại môn F. KHÔNG tư vấn đăng ký môn học mới, trả lời ngắn gọn súc tích.`;
            logger.info(`Enrich: CPA ${cpa} < 2.0 → added program (Cải thiện điểm)`);
        }
    }

    return {
        needs_more: additional_skills.length > 0,
        additional_skills,
        enrichment_queries,
    };
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export async function enrichCheckNode(
    state: typeof StateAnnotation.State,
): Promise<Partial<typeof StateAnnotation.State>> {
    const iteration = state.iteration_count ?? 0;

    // Guard: Tránh vòng lặp vô tận
    if (iteration >= MAX_ITERATIONS) {
        logger.info('Max iterations reached — proceeding to compose', { iteration });
        return { iteration_count: iteration };
    }

    if (!state.skill_results || state.skill_results.length === 0) {
        return { iteration_count: iteration };
    }

    const { needs_more, additional_skills, enrichment_queries } = detectEnrichmentNeeds(state);

    if (!needs_more) {
        logger.info('Context sufficient — proceeding to compose', { iteration });
        return { iteration_count: iteration };
    }

    logger.info('Enrichment needed — scheduling additional skills', {
        additional_skills,
        iteration: iteration + 1,
    });

    return {
        // Ghi đè selected_skills bằng các skill bổ sung để chạy ở vòng tiếp theo
        selected_skills: additional_skills,
        enrichment_queries,
        iteration_count: iteration + 1,
    };
}

/** Conditional edge: Quyết định vòng lặp hay đi tới Compose */
export function shouldEnrich(state: typeof StateAnnotation.State): 'execute_skills' | 'compose' {
    const iteration = state.iteration_count ?? 0;
    const hasAdditional = state.selected_skills?.length > 0;

    if (iteration > 0 && hasAdditional && iteration <= MAX_ITERATIONS) {
        // Chống lặp vô tận bằng cách check xem skill đó ĐÃ CHẠY ở các vòng trước chưa
        const previouslyRan = new Set(state.skill_results.map((r) => r.skill));
        const hasNewSkills = state.selected_skills.some((s) => !previouslyRan.has(s));
        
        if (hasNewSkills) {
            return 'execute_skills';
        }
    }

    return 'compose';
}