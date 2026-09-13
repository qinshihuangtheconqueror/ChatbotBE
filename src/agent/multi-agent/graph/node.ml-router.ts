import axios from 'axios';

export interface MLRouteResult {
    agent: string;
    confidence: number;
    intent: string;
    use_ml: boolean;
    error?: string;
}

export class MlRouterClient {

    private readonly baseUrl: string;

    constructor() {

        this.baseUrl =
            process.env.ML_ROUTER_URL ||
            'http://localhost:8000';
    }

    async route(
        query: string,
    ): Promise<MLRouteResult> {

        try {

            const response =
                await axios.post(
                    `${this.baseUrl}/route`,
                    { query },
                    {
                        timeout: 3000,
                    },
                );

            return response.data;

        } catch (error: any) {

            return {
                agent: 'rag',
                confidence: 0,
                intent: 'error',
                use_ml: false,
                error: error.message,
            };
        }
    }
}


import {
    LangGraphRunnableConfig,
} from '@langchain/langgraph';

import { StateAnnotation }
    from './state';

const mlClient =
    new MlRouterClient();

export async function mlRouterNode(
    state: typeof StateAnnotation.State,
    _config?: LangGraphRunnableConfig,
): Promise<
    Partial<typeof StateAnnotation.State>
> {

    try {

        const query =
            String(
                state.rewritten_query ||
                state.messages?.at(-1)?.content ||
                '',
            );

        if (!query) {
            return {};
        }

        const result =
            await mlClient.route(query);

        console.log(
            '[ML ROUTER]',
            result,
        );

        return {
            ml_route: result,
        };

    } catch (error: any) {

        console.error(
            '[ML ROUTER ERROR]',
            error,
        );

        return {
            ml_route: {
                agent: 'rag',
                confidence: 0,
                intent: 'error',
                use_ml: false,
                error: error.message,
            },
        };
    }
}

