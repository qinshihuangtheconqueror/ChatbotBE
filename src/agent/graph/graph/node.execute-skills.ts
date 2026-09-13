import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { trace } from '@opentelemetry/api';
import { StateAnnotation, SkillResult, Citation } from './state';
import { SkillRegistry } from '../../skills/registry';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('ExecuteSkillsNode');

export async function executeSkillsNode(
    state: typeof StateAnnotation.State,
    config?: LangGraphRunnableConfig,
    registry?: SkillRegistry,
): Promise<Partial<typeof StateAnnotation.State>> {
    const skills = state.selected_skills;
    const iteration = state.iteration_count ?? 0;
    const enrichmentQueries = state.enrichment_queries ?? {};

    // ── CHITCHAT BYPASS ──
    // Nếu mảng skills rỗng, đây là luồng Chitchat/Giao tiếp. Trả về ngay lập tức để Compose Node xử lý.
    if (!skills || skills.length === 0) {
        logger.info('ExecuteSkills: No skills selected (Chitchat detected) — bypassing execution.');
        return {}; 
    }

    if (!registry) {
        logger.error('SkillRegistry not provided');
        return {
            error: { code: 'INTERNAL', message: 'SkillRegistry not wired', where: 'execute_skills' },
        };
    }

    logger.info('Executing skills in parallel', { skills, iteration });

    const getSkillConfig = (skillName: string): LangGraphRunnableConfig => {
        const enrichedQuery = enrichmentQueries[skillName];
        if (enrichedQuery && config) {
            return {
                ...config,
                configurable: {
                    ...config.configurable,
                    enriched_query: enrichedQuery,
                },
            };
        }
        return config ?? {};
    };

    // Chạy song song các Skill
    const settled = await Promise.allSettled(
        skills.map(async (skillName) => {
            if (!registry.has(skillName)) {
                throw new Error(`Skill "${skillName}" not registered`);
            }
            const skill = registry.get(skillName)!;
            return skill.run(state, getSkillConfig(skillName));
        }),
    );

    // Thu thập kết quả
    const newSkillResults: SkillResult[] = [];
    const allCitations: Citation[] = [];
    let mergedState: Partial<typeof StateAnnotation.State> = {};
    let allFailed = true;

    settled.forEach((result, i) => {
        const skillName = skills[i];
        if (result.status === 'fulfilled') {
            allFailed = false;
            const patch = result.value as Partial<typeof StateAnnotation.State>;
            
            // ── LẤY ĐÚNG DỮ LIỆU TỪ SKILL TRẢ VỀ ──
            // Các skill hiện tại đều trả về mảng skill_results chứa sẵn data và llm_instruction
            if (patch.skill_results && patch.skill_results.length > 0) {
                newSkillResults.push(...patch.skill_results);
            } else {
                // Fallback nếu có skill nào chưa làm chuẩn format
                newSkillResults.push({ skill: skillName, success: true, data: patch as any });
            }

            if (patch.citations && patch.citations.length > 0) {
                allCitations.push(...patch.citations);
            }

            // Gộp các state khác (nếu có)
            const { citations: _c, skill_results: _sr, ...rest } = patch;
            mergedState = { ...mergedState, ...rest };
        } else {
            const errMsg = (result.reason as Error)?.message || 'Unknown error';
            logger.warn(`Skill "${skillName}" failed`, { error: errMsg, iteration });
            newSkillResults.push({ skill: skillName, success: false, error: errMsg });
        }
    });

    // OTel span attributes (Trắc lượng)
    const span = trace.getActiveSpan();
    if (span) {
        span.setAttribute('skills.attempted', skills.join(', '));
        span.setAttribute('skills.iteration', iteration);
        const succeeded = newSkillResults.filter((r) => r.success).map((r) => r.skill);
        const failed = newSkillResults.filter((r) => !r.success).map((r) => r.skill);
        span.setAttribute('skills.succeeded', succeeded.join(', ') || 'none');
        span.setAttribute('skills.failed', failed.join(', ') || 'none');
    }

    if (allFailed) {
        return {
            skill_results: [...(state.skill_results ?? []), ...newSkillResults],
            error: {
                code: 'SKILL_FAILED',
                message: 'Rất tiếc, các hệ thống tra cứu nội bộ đang không phản hồi. Vui lòng thử lại sau.',
                where: 'execute_skills',
            },
        };
    }

    return {
        ...mergedState,
        skill_results: [...(state.skill_results ?? []), ...newSkillResults],
        citations: allCitations,
    };
}