import { CompiledStateGraph } from '@langchain/langgraph';
import { StructuredTool } from '@langchain/core/tools';

import { AppState } from '../graph/state';

export interface AgentDefinition {
    name: string;

    systemPrompt: string;

    tools: StructuredTool[];

    graph: any;
}