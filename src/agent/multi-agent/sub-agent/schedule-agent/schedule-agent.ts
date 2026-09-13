import { BaseAgent } from '../../base/base-agent';

import { buildScheduleTools } from './tools';

import { SCHEDULE_PROMPT } from './prompts';

import { SkillRegistry } from '../../../skills/registry';

import { LlmFactory } from '../../../llm/llm.factory';

import { AppState } from '../../graph/state';

export class ScheduleAgent extends BaseAgent {

    protected name = 'schedule-agent';

    protected systemPrompt = SCHEDULE_PROMPT;

    protected tools;

    constructor(
        llmFactory: LlmFactory,
        registry: SkillRegistry,
    ) {

        super(llmFactory);

        this.tools = buildScheduleTools(
            registry,
        );
    }
}