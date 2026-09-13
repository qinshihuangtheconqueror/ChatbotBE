import { StateAnnotation, SkillResult } from '../../graph/state';

export function firstResult(
    patch: Partial<typeof StateAnnotation.State>
): SkillResult | undefined {
    return patch.skill_results?.[0];
}