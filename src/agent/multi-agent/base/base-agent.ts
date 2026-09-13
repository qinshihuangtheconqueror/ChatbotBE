import {
    StateGraph,
    START,
    END,
} from '@langchain/langgraph';

import {
    AIMessage,
    BaseMessage,
} from '@langchain/core/messages';

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

// @ts-ignore
import { ToolNode } from '@langchain/langgraph/prebuilt';

import { StructuredTool } from '@langchain/core/tools';

import { AppState, StateAnnotation } from '../graph/state';

import { LlmFactory } from '../../llm/llm.factory';
import { ConsoleLogger } from '@nestjs/common';

export abstract class BaseAgent {

    protected abstract name: string;

    protected abstract systemPrompt: string;

    protected abstract tools: StructuredTool[];

    constructor(
        protected readonly llmFactory: LlmFactory,
    ) {}

    /* ──────────────────────────────────────────
     * Build Graph
     * ────────────────────────────────────────── */


    build() {
        // 🔥 FIX: Nối liền toàn bộ các hàm bằng dấu chấm (.)
        const builder = new StateGraph(StateAnnotation)
            .addNode('call_model', this.callModel.bind(this))
            .addNode('tools', new ToolNode(this.tools))
            .addEdge(START, 'call_model')
            .addConditionalEdges('call_model', this.routeModelOutput.bind(this))
            .addEdge('tools', 'call_model');

        return builder.compile({
            name: this.name,
        });
    }
    /* ──────────────────────────────────────────
     * Model Node
     * ────────────────────────────────────────── */

    protected async callModel(
        state: AppState,
    ): Promise<Partial<AppState>> {

        const model = (this.llmFactory.getModel('flash') as ChatGoogleGenerativeAI).bindTools(this.tools);
        const response = await model.invoke([
            {
                role: 'system',
                content: this.systemPrompt,
            },

            ...state.messages,
        ]);

        

        return {
            messages: [
                response,
            ] as BaseMessage[],

            current_agent: this.name,
        };
    }

    /* ──────────────────────────────────────────
     * Router
     * ────────────────────────────────────────── */

    protected routeModelOutput(
        state: AppState,
    ): '__end__' | 'tools' {

        const lastMessage =
            state.messages.at(-1);
        if (
            lastMessage instanceof AIMessage &&
            lastMessage.tool_calls?.length
        ) {
            return 'tools';
        }

        return '__end__';
    }

    public getTools() {
    return this.tools;
}

    public getCallModel() {
        return this.callModel.bind(this);
    }
}
