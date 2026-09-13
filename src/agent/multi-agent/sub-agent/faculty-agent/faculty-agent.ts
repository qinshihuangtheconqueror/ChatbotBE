import { BaseAgent } from '../../base/base-agent';

import { buildFacultyCareerTools } from './tools';

import { FACULTY_PROMPT } from './prompts';

import { SkillRegistry } from '../../../skills/registry';

import { LlmFactory } from '../../../llm/llm.factory';

import { AppState } from '../../graph/state';

export class FacultyAgent extends BaseAgent {

    protected name = 'faculty-agent';

    protected systemPrompt = FACULTY_PROMPT;

    protected tools;

    constructor(
        llmFactory: LlmFactory,
        registry: SkillRegistry,
    ) {

        super(llmFactory);

        this.tools = buildFacultyCareerTools(
            registry,
        );
    }
}