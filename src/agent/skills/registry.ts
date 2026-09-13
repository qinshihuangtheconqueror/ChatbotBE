import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from '../graph/graph/state';

export interface SkillDefinition {
    name: string;
    description: string;
    run(
        state: typeof StateAnnotation.State,
        config?: LangGraphRunnableConfig,
    ): Promise<Partial<typeof StateAnnotation.State>>;
}

export class SkillRegistry {
    private skills = new Map<string, SkillDefinition>();

    register(skill: SkillDefinition): void {
        this.skills.set(skill.name, skill);
    }

    get(name: string): SkillDefinition | undefined {
        return this.skills.get(name);
    }

    has(name: string): boolean {
        return this.skills.has(name);
    }

    list(): SkillDefinition[] {
        return Array.from(this.skills.values());
    }
}
