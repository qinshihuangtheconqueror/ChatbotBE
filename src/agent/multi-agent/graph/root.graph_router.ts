import {
    StateGraph,
    START,
    END,
    MemorySaver,
    LangGraphRunnableConfig,
    CompiledStateGraph,
} from '@langchain/langgraph';

import {
    MongoDBSaver,
} from '@langchain/langgraph-checkpoint-mongodb';

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

import { mlRouterNode }
    from './node.ml-router';

import { createAcademicNode }
    from './node.academic';

import { createScheduleNode }
    from './node.schedule';

import { createFacultyNode }
    from './node.faculty';

import { HistoryStore }
    from '../../persistence/history.store';

import { SkillRegistry }
    from '../../skills/registry';

import { LlmFactory }
    from '../../llm/llm.factory';

import { SupervisorAgent }
    from '../supervisor-agent/supervisor';

import { HustApiClient }
    from '../../tools/clients/hust-api.client';

import { RedisClient }
    from '../../tools/clients/redis.client';

import { AcademicAgent }
    from '../sub-agent/academic-agent/academic-agent';

import { ScheduleAgent }
    from '../sub-agent/schedule-agent/schedule-agent';

import { FacultyAgent }
    from '../sub-agent/faculty-agent/faculty-agent';

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
 * ML Router Decision
 * ────────────────────────────────────────── */

function routeAfterMl(
    state: typeof StateAnnotation.State,
): string {

    const ml =
        state.ml_route;

    console.log(
        '[ML ROUTE DECISION]',
        ml,
    );

    if (
        ml?.use_ml &&
        ml?.confidence >= 0.9
    ) {

        switch (ml.agent) {

            case 'academic':
                return 'academic_agent';

            case 'schedule':
                return 'schedule_agent';

            case 'faculty':
                return 'faculty_agent';

            default:
                return 'supervisor';
        }
    }

    return 'supervisor';
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
     * Shared Agent Instances
     * ────────────────────────────────────── */

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

    /* ──────────────────────────────────────
     * Wrappers
     * ────────────────────────────────────── */

    const loadCtxWrapper =
        (
            s: S,
            c: LangGraphRunnableConfig,
        ) =>
            loadContextNode(
                s,
                c,
                historyStore,
                hustApi,
                redis,
            );

    const supervisorWrapper =
        createSupervisorNode(
            supervisor,
        );

    const academicWrapper =
        createAcademicNode(
            academicAgent,
        );

    const scheduleWrapper =
        createScheduleNode(
            scheduleAgent,
        );

    const facultyWrapper =
        createFacultyNode(
            facultyAgent,
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

            /* ──────────────────────────────
             * Nodes
             * ────────────────────────────── */

            .addNode(
                'load_context',
                loadCtxWrapper,
            )

            .addNode(
                'ml_router',
                mlRouterNode,
            )

            .addNode(
                'supervisor',
                supervisorWrapper,
            )

            .addNode(
                'academic_agent',
                academicWrapper,
            )

            .addNode(
                'schedule_agent',
                scheduleWrapper,
            )

            .addNode(
                'faculty_agent',
                facultyWrapper,
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

            /* ──────────────────────────────
             * load_context
             * ────────────────────────────── */

            .addConditionalEdges(
                'load_context',
                (s) => {

                    return guard(
                        s,
                        'ml_router',
                    );
                },
            )

            /* ──────────────────────────────
             * ml_router
             * ────────────────────────────── */

            .addConditionalEdges(
                'ml_router',
                (s) => {

                    console.log(
                        '[GRAPH] after ml_router',
                        {
                            ml_route:
                                s.ml_route,

                            error:
                                s.error,
                        },
                    );

                    return guard(
                        s,
                        routeAfterMl(s),
                    );
                },
            )

            /* ──────────────────────────────
             * supervisor
             * ────────────────────────────── */

            .addConditionalEdges(
                'supervisor',
                (s) => {

                    console.log(
                        '[GRAPH] after supervisor',
                        {
                            messages:
                                s.messages,

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

            /* ──────────────────────────────
             * academic_agent
             * ────────────────────────────── */

            .addConditionalEdges(
                'academic_agent',
                (s) => {

                    console.log(
                        '[GRAPH] after academic_agent',
                        {
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

            /* ──────────────────────────────
             * schedule_agent
             * ────────────────────────────── */

            .addConditionalEdges(
                'schedule_agent',
                (s) => {

                    console.log(
                        '[GRAPH] after schedule_agent',
                        {
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

            /* ──────────────────────────────
             * faculty_agent
             * ────────────────────────────── */

            .addConditionalEdges(
                'faculty_agent',
                (s) => {

                    console.log(
                        '[GRAPH] after faculty_agent',
                        {
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

            /* ──────────────────────────────
             * finalize
             * ────────────────────────────── */

            .addEdge(
                'finalize',
                END,
            )

            /* ──────────────────────────────
             * error
             * ────────────────────────────── */

            .addEdge(
                'handle_error',
                'finalize',
            );

    return workflow.compile({
        checkpointer: saver,
        name: 'HustVA-HybridGraph',
    });
}

