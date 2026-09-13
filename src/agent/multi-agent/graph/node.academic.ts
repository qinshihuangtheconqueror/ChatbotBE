
import {
    LangGraphRunnableConfig,
} from '@langchain/langgraph';

import { StateAnnotation }
    from './state';

export function createAcademicNode(
    academicAgent: any,
) {

    return async function academicNode(
        state: typeof StateAnnotation.State,
        config?: LangGraphRunnableConfig,
    ): Promise<
        Partial<typeof StateAnnotation.State>
    > {

        const response =
            await academicAgent.invoke(
                {
                    ...state,
                },
                config,
            );

        return {
            ...response,

            current_agent:
                'academic-agent',
        };
    };
}
