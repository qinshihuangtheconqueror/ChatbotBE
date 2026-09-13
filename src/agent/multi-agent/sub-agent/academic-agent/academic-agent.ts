import { BaseAgent } from '../../base/base-agent';

import { buildAcademicTools } from './tools';

import { ACADEMIC_PROMPT } from './prompts';

import { SkillRegistry } from '../../../skills/registry';

import { LlmFactory } from '../../../llm/llm.factory';

export class AcademicAgent extends BaseAgent {

    protected name = 'academic-agent';

    protected systemPrompt = ACADEMIC_PROMPT;

    protected tools;

    constructor(
        llmFactory: LlmFactory,
        registry: SkillRegistry,
    ) {

        super(llmFactory);

        this.tools =
            buildAcademicTools(
                registry,
            );
    }
}