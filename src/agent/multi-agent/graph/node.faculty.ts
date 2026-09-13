import {
    LangGraphRunnableConfig,
} from '@langchain/langgraph';

import { StateAnnotation }
    from './state';

export function createFacultyNode(
    facultyAgent: any,
) {

    return async function facultyNode(
        state: typeof StateAnnotation.State,
        config?: LangGraphRunnableConfig,
    ): Promise<
        Partial<typeof StateAnnotation.State>
    > {

        const response =
            await facultyAgent.invoke(
                {
                    ...state,
                },
                config,
            );

        return {
            ...response,

            current_agent:
                'faculty-agent',
        };
    };
}

