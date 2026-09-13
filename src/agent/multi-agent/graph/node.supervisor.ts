import {
    LangGraphRunnableConfig,
} from '@langchain/langgraph';

import {
    BaseMessage,
    AIMessage,
    ToolMessage,
} from '@langchain/core/messages';

import { StateAnnotation }
    from './state';
import { logger } from '@zilliz/milvus2-sdk-node';

export function createSupervisorNode(
    supervisor: any,
) {

    return async function supervisorNode(
        state: typeof StateAnnotation.State,
        _config?: LangGraphRunnableConfig,
    ): Promise<
        Partial<typeof StateAnnotation.State>
    > {

        try {

            const messages =
                (state.messages || []) as BaseMessage[];

            console.log(
                '[SUPERVISOR INPUT]',
                messages.map((m, i) => ({
                    index: i,
                    type: m?.constructor?.name,
                })),
            );

            /**
             * invoke supervisor
             */
            const responseState = await supervisor.invoke({
                ...state,
                messages,
            }, _config);

            console.log(
                '[SUPERVISOR RESPONSE]',
                {
                    messageCount:
                        responseState?.messages?.length,

                    currentAgent:
                        responseState?.current_agent,

                    hasError:
                        !!responseState?.error,
                },
            );

            /**
             * Extract policy contexts
             */
            let policyContexts: any[] = [];

            const updatedMessages =
                (responseState.messages || []) as BaseMessage[];

            for (const msg of updatedMessages) {

                if (
                    msg instanceof ToolMessage &&
                    typeof msg.content === 'string'
                ) {

                    try {

                        const parsed =
                            JSON.parse(msg.content);

                        if (
                            parsed?.policy_contexts
                        ) {

                            policyContexts =
                                parsed.policy_contexts;
                        }

                    } catch {
                        // ignore non-json tool outputs
                    }
                }
            }

            /**
             * Only append new messages
             */
            const newMessages =
                updatedMessages.slice(
                    messages.length,
                );

            /**
             * Extract final AI text
             */
            const newAiMessages = newMessages.filter((m) => {
                const type = m._getType?.() ?? m.getType?.() ?? (m as any).type;
                return type === 'ai' || type === 'AIMessageChunk';
            });

            // Nối toàn bộ nội dung của các chunk lại với nhau
            let extractedText = newAiMessages
                .map((m) => {
                    if (typeof m.content === 'string') {
                        return m.content;
                    } else if (Array.isArray(m.content)) {
                        return (m.content as any[])
                            .filter((c: any) => c.type === 'text' && c.text)
                            .map((c: any) => c.text)
                            .join('\n');
                    }
                    return '';
                })
                .join('')
                .trim();
            
            return {
                messages: newMessages,
                final_text: extractedText || null, // Nếu rỗng thì trả về null
                current_agent: 'supervisor-agent',
                policy_contexts: policyContexts,
            };

        } catch (error: any) {

            console.error(
                '[SupervisorNode ERROR]',
                error,
            );

            return {
                error: {
                    code:
                        'INTERNAL',

                    message:
                        error?.message ||
                        'Supervisor node failed',
                },
            };
        }
    };
}