import {
    LangGraphRunnableConfig,
} from '@langchain/langgraph';

import { StateAnnotation }
    from './state';

export function createScheduleNode(
    scheduleAgent: any,
) {

    return async function scheduleNode(
        state: typeof StateAnnotation.State,
        config?: LangGraphRunnableConfig,
    ): Promise<
        Partial<typeof StateAnnotation.State>
    > {

        const response =
            await scheduleAgent.invoke(
                {
                    ...state,
                },
                config,
            );

        return {
            ...response,

            current_agent:
                'schedule-agent',
        };
    };
}

