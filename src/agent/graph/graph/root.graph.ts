import { StateGraph, START, END, MemorySaver, LangGraphRunnableConfig, CompiledStateGraph } from '@langchain/langgraph';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { StateAnnotation } from './state';
import { ingressNode } from './node.ingress';
import { loadContextNode } from './node.load-context';
// import { createRewriteNode } from './node.rewrite';             // Đã tắt Rewrite Node
import { ruleRouterNode } from './node.rule-router';             // Không import shouldSkipLlmRoute nữa
import { signalRouterNode } from './node.signal-router';         // Không import shouldSkipSemanticRoute nữa
import { createReactNode } from '../react/node.react';           // Layer 2: ReAct agent kiêm Execution
// import { executeSkillsNode } from './node.execute-skills';      // Đã chuyển Execution vào trong ReAct Agent
// import { enrichCheckNode, shouldEnrich } from './node.enrich-check'; // Đã tắt Enrich
import { createComposeNode } from './node.compose';
import { finalizeNode } from './node.finalize';
import { createGenerateTitleNode, shouldGenerateTitle } from './node.generate-title';
import { handleErrorNode } from './node.handle-error';
import { HistoryStore } from '../../persistence/history.store';
import { SkillRegistry } from '../../skills/registry';
import { LlmFactory } from '../../llm/llm.factory';
import { PromptLoader } from '../../prompts/prompt-loader';
import { HustApiClient } from '../../tools/clients/hust-api.client';
import { RedisClient } from '../../tools/clients/redis.client';

/** Route all nodes through global error guard */
function guard(state: typeof StateAnnotation.State, next: string): string {
    return state.error ? 'handle_error' : next;
}

export function createGraph(
    checkpointer?: MongoDBSaver | MemorySaver,
    historyStore?: HistoryStore,
    skillRegistry?: SkillRegistry,
    llmFactory?: LlmFactory,
    promptLoader?: PromptLoader,
    hustApi?: HustApiClient,
    redis?: RedisClient,
): CompiledStateGraph<any, any, any> {
    const saver = checkpointer || new MemorySaver();

    // Inject deps via closures — nodes stay pure functions
    type S = typeof StateAnnotation.State;
    const loadCtxWrapper  = (s: S, c: LangGraphRunnableConfig) => loadContextNode(s, c, historyStore, hustApi, redis);
    // const rewriteWrapper  = createRewriteNode(llmFactory, promptLoader);
    const reactWrapper    = createReactNode(llmFactory, skillRegistry);
    // const executeWrapper  = (s: S, c: LangGraphRunnableConfig) => executeSkillsNode(s, c, skillRegistry);
    const composeWrapper  = createComposeNode(llmFactory, promptLoader);
    const generateTitleWrapper = createGenerateTitleNode(llmFactory);
    const finalizeWrapper = (s: S, c: LangGraphRunnableConfig) => finalizeNode(s, c, historyStore);

    const workflow = new StateGraph(StateAnnotation)
        .addNode('ingress',           ingressNode)
        .addNode('load_context',      loadCtxWrapper)
        // .addNode('rewrite',           rewriteWrapper)       // Đã tắt
        .addNode('rule_router',       ruleRouterNode)       // Ghi điểm Regex (+0.1)
        .addNode('signal_router',     signalRouterNode)     // Ghi điểm kNN Vector
        .addNode('react',             reactWrapper)         // Hợp nhất điểm, Lọc Tools -> Chọn -> Chạy Tool
        // .addNode('execute_skills',    executeWrapper)       // Đã tắt
        // .addNode('enrich_check',      enrichCheckNode)      // Đã tắt
        .addNode('compose',           composeWrapper)       // Sinh câu trả lời dựa trên kết quả Tool
        .addNode('generate_title',    generateTitleWrapper)
        .addNode('finalize',          finalizeWrapper)
        .addNode('handle_error',      handleErrorNode)

        .addEdge(START, 'ingress')
        .addConditionalEdges('ingress',      (s) => guard(s, 'load_context'))
        .addConditionalEdges('load_context', (s) => guard(s, 'rule_router'))
        .addConditionalEdges('rule_router',  (s) => guard(s, 'signal_router'))
        .addConditionalEdges('signal_router',(s) => guard(s, 'react'))
        .addConditionalEdges('react',        (s) => guard(s, 'compose'))
        .addConditionalEdges('compose', shouldGenerateTitle)
        .addEdge('generate_title', 'finalize')
        .addEdge('finalize', END)
        .addEdge('handle_error', 'finalize');

    return workflow.compile({ checkpointer: saver, name: 'HustVAGraph' });
}
