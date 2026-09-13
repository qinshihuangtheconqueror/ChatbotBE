/**
 * Langfuse tracing adapter — official TS pattern from langfuse.com/docs/integrations/langchain/tracing
 *
 * Key requirements (from official docs):
 * 1. LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL env vars
 * 2. LANGCHAIN_CALLBACKS_BACKGROUND=false — without this, LangChain v0.3+ runs
 *    callbacks in background, meaning graph.invoke() returns before Langfuse gets traces
 * 3. Call handler.flushAsync() after graph.invoke() for long-running servers
 */
import { CallbackHandler } from '@langfuse/langchain';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { TracingContext, TracingProvider } from './tracing.port';
import { createLogger } from '@/common/logger/logger';
import { envConfig } from '@/common/config/env.config';

const logger = createLogger('LangfuseTracingProvider');

export class LangfuseTracingProvider implements TracingProvider {
    readonly name = 'langfuse';

    private _handler: CallbackHandler | null = null;

    createCallbackHandler(ctx: TracingContext): BaseCallbackHandler | undefined {
        const pk = envConfig.LANGFUSE_PUBLIC_KEY || process.env.LANGFUSE_PUBLIC_KEY;
        const sk = envConfig.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_SECRET_KEY;
        
        if (!pk || !sk) {
            logger.warn('Langfuse keys missing');
            return undefined;
        }

        // Docs require LANGFUSE_BASE_URL (with underscore) — set it explicitly from any variant
        if (!process.env.LANGFUSE_BASE_URL) {
            process.env.LANGFUSE_BASE_URL =
                process.env.LANGFUSE_BASEURL ||
                process.env.LANGFUSE_HOST ||
                'https://us.cloud.langfuse.com';
        }

        // Docs: set LANGCHAIN_CALLBACKS_BACKGROUND=false for non-serverless long-running servers
        // This ensures callbacks run SYNCHRONOUSLY and graph.invoke() waits for them
        if (!process.env.LANGCHAIN_CALLBACKS_BACKGROUND) {
            process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
        }

        try {
            const handler = new CallbackHandler({
                sessionId: ctx.threadId,
                userId: ctx.userId || ctx.threadId,
                tags: ['HustVA-V3', `thread:${ctx.threadId}`, ...(ctx.tags ?? [])],
                traceMetadata: ctx.input ?? {},
            });
            this._handler = handler;
            logger.info('Langfuse CallbackHandler created', {
                baseUrl: process.env.LANGFUSE_BASE_URL,
                background: process.env.LANGCHAIN_CALLBACKS_BACKGROUND,
                session: ctx.threadId,
            });
            return handler as unknown as BaseCallbackHandler;
        } catch (e) {
            logger.error('Langfuse handler creation failed', { error: (e as Error).message });
            return undefined;
        }
    }

    /** Flush pending spans — call after graph.invoke() per official docs */
    async flush(): Promise<void> {
        const h = this._handler;
        if (!h) return;
        try {
            // Official docs: await langfuseHandler.flushAsync()
            await (h as any).flushAsync?.();
        } catch (e) {
            logger.warn('Langfuse flush error', { error: (e as Error).message });
        }
    }
}
