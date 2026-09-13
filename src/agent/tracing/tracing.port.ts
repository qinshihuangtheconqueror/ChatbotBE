/**
 * Tracing Port — framework-agnostic interface.
 */
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';

export interface TracingContext {
    threadId: string;
    userId: string;
    requestId: string;
    input?: Record<string, unknown>;
    /** Optional extra tags to attach to the trace */
    tags?: string[];
}

export interface TracingProvider {
    readonly name: string;
    createCallbackHandler(ctx: TracingContext): BaseCallbackHandler | undefined;
    /** Flush pending traces — call after graph.invoke() completes */
    flush?(): Promise<void>;
}
