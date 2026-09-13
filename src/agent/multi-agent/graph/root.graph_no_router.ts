import {
    StateGraph,
    START,
    END,
    MemorySaver,
    LangGraphRunnableConfig,
    CompiledStateGraph,
} from '@langchain/langgraph';

import { MongoDBSaver }
    from '@langchain/langgraph-checkpoint-mongodb';

import { StateAnnotation }
    from './state';

import { loadContextNode }
    from './node.load-context';

import { createSupervisorNode }
    from './node.supervisor';

import { finalizeNode }
    from './node.finalize';

import { handleErrorNode }
    from './node.handle-error';

import { HistoryStore }
    from '../../persistence/history.store';

import { SkillRegistry }
    from '../../skills/registry';

import { LlmFactory }
    from '../../llm/llm.factory';

import { SupervisorAgent } from '../supervisor-agent/supervisor'

import { HustApiClient }
    from '../../tools/clients/hust-api.client';

import { RedisClient }
    from '../../tools/clients/redis.client';

import { AcademicAgent } from '../sub-agent/academic-agent/academic-agent';

import { ScheduleAgent } from '../sub-agent/schedule-agent/schedule-agent';

import { FacultyAgent } from '../sub-agent/faculty-agent/faculty-agent';

/* ──────────────────────────────────────────
 * Guard
 * ────────────────────────────────────────── */

function guard(
    state: typeof StateAnnotation.State,
    next: string,
) {

    if (state.error) {
        return 'handle_error';
    }

    return next;
}

/* ──────────────────────────────────────────
 * Graph
 * ────────────────────────────────────────── */

export function createGraph(
    checkpointer?: MongoDBSaver | MemorySaver,

    historyStore?: HistoryStore,

    skillRegistry?: SkillRegistry,

    llmFactory?: LlmFactory,

    hustApi?: HustApiClient,

    redis?: RedisClient,

): CompiledStateGraph<any, any, any> {

    const saver =
        checkpointer ??
        new MemorySaver();

    type S =
        typeof StateAnnotation.State;

    /* ──────────────────────────────────────
     * Wrappers
     * ────────────────────────────────────── */

    const loadCtxWrapper  = (s: S, c: LangGraphRunnableConfig) => loadContextNode(s, c, historyStore, hustApi, redis);
    


const academicAgent =
    new AcademicAgent(
        llmFactory!,
        skillRegistry!,
    ).build();

const scheduleAgent =
    new ScheduleAgent(
        llmFactory!,
        skillRegistry!,
    ).build();

const facultyAgent =
    new FacultyAgent(
        llmFactory!,
        skillRegistry!,
    ).build();

const supervisor =
    new SupervisorAgent(
        llmFactory!,
        {
            academicAgent,
            scheduleAgent,
            facultyAgent,
        },
    ).build();

const supervisorWrapper =
    createSupervisorNode(
        supervisor,
    );



    const finalizeWrapper =
        (
            s: S,
            c: LangGraphRunnableConfig,
        ) =>
            finalizeNode(
                s,
                c,
                historyStore,
            );

    /* ──────────────────────────────────────
     * Workflow
     * ────────────────────────────────────── */

    const workflow =
        new StateGraph(StateAnnotation)

            .addNode(
                'load_context',
                loadCtxWrapper,
            )

            .addNode(
                'supervisor',
                supervisorWrapper,
            )

            .addNode(
                'finalize',
                finalizeWrapper,
            )

            .addNode(
                'handle_error',
                handleErrorNode,
            )

            /* ──────────────────────────────
             * Flow
             * ────────────────────────────── */

            .addEdge(
                START,
                'load_context',
            )

            .addConditionalEdges(
                'load_context',
                (s) => {
                    return guard(
                        s,
                        'supervisor',
                    );
                },
            )

            .addConditionalEdges(
                'supervisor',
                (s) => {

                    console.log(
                        '[GRAPH] after supervisor',
                        {
                            messages:
                                s.messages?.length,

                            final:
                                s.final_text,

                            error:
                                s.error,
                        },
                    );

                    return guard(
                        s,
                        'finalize',
                    );
                },
            )

            .addEdge(
                'finalize',
                END,
            )

            .addEdge(
                'handle_error',
                'finalize',
            );

    return workflow.compile({
        checkpointer: saver,
        name: 'HustVA-SupervisorGraph',
    });
}