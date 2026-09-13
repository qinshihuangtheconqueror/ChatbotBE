/**
 * Context Injector Middleware
 *
 * Runs before the graph starts (beforeAgent phase).
 * - Resets per-run counters to zero
 * - Stamps user_key, thread_id, request_id, run_start into metadata
 *   so downstream logs/traces can reference them
 */
import { AgentMiddleware, MiddlewareContext } from './types';

export const contextInjectorMiddleware: AgentMiddleware = {
    name: 'context-injector',

    beforeAgent(ctx: MiddlewareContext): void {
        // Reset per-run counters
        ctx.counters.tool_errors = 0;
        ctx.counters.retries = 0;
        ctx.counters.loop_count = 0;

        // Stamp into metadata
        ctx.metadata['user_key'] = ctx.user_key;
        ctx.metadata['thread_id'] = ctx.thread_id;
        ctx.metadata['request_id'] = ctx.request_id;
        ctx.metadata['run_start'] = new Date().toISOString();
    },
};
