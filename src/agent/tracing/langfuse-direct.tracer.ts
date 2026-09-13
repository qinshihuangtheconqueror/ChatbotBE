/**
 * Direct Langfuse SDK tracer.
 * Uses `langfuse` package (not @langfuse/langchain) so traces are guaranteed
 * to reach Langfuse even when LangGraph doesn't forward callbacks.
 *
 * Usage:
 *   const span = LangfuseTracer.startTrace({ name, input, userId, sessionId });
 *   // ... do work ...
 *   span.end({ output, metadata });
 */
import { Langfuse } from 'langfuse';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('LangfuseTracer');

let _client: Langfuse | null = null;

export function getLangfuseClient(): Langfuse | null {
    if (_client) return _client;

    const pk = envConfig.LANGFUSE_PUBLIC_KEY;
    const sk = envConfig.LANGFUSE_SECRET_KEY;
    const baseUrl =
        process.env.LANGFUSE_BASEURL ||
        process.env.LANGFUSE_BASE_URL ||
        envConfig.LANGFUSE_HOST ||
        'https://us.cloud.langfuse.com';

    if (!pk || !sk) {
        logger.warn('Langfuse keys missing — tracing disabled');
        return null;
    }

    _client = new Langfuse({ publicKey: pk, secretKey: sk, baseUrl });
    logger.info('Langfuse SDK client initialized', { baseUrl, pk: pk.slice(0, 15) });
    return _client;
}

export interface TraceOptions {
    name: string;
    input?: Record<string, unknown>;
    userId?: string;
    sessionId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
}

export interface TraceHandle {
    end(opts: { output?: unknown; metadata?: Record<string, unknown> }): Promise<void>;
}

export const LangfuseTracer = {
    start(opts: TraceOptions): TraceHandle {
        const client = getLangfuseClient();
        if (!client) {
            return { end: async () => { } };
        }

        const trace = client.trace({
            name: opts.name,
            input: opts.input,
            userId: opts.userId,
            sessionId: opts.sessionId,
            tags: opts.tags,
            metadata: opts.metadata,
        });

        return {
            async end({ output, metadata }) {
                trace.update({ output, metadata });
                // Flush without blocking the response
                client.flushAsync().catch(e =>
                    logger.warn('Langfuse flush error', { error: (e as Error).message }),
                );
            },
        };
    },
};
