import { BaseAgent }
    from '../base/base-agent';

import { StructuredTool }
    from '@langchain/core/tools';

import { LlmFactory }
    from '../../llm/llm.factory';

import { createSubAgentTools }
    from './build-sub-agent-tools';

import { SupervisorSubAgents }
    from './sub-agent.types';

import {SUPERVISOR_PROMPT} 
    from "./prompts"

export class SupervisorAgent
    extends BaseAgent {

    protected name =
        'supervisor-agent';

    protected systemPrompt = SUPERVISOR_PROMPT;

    protected tools: StructuredTool[];

    constructor(
        llmFactory: LlmFactory,

        subAgents: SupervisorSubAgents,
    ) {

        super(llmFactory);

        this.tools =
            createSubAgentTools(
                subAgents.academicAgent,
                subAgents.scheduleAgent,
                subAgents.facultyAgent,
            );
    }
}

