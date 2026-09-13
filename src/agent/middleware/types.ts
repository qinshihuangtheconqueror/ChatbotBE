/**
 * Agent Middleware Pipeline — framework-agnostic (NO NestJS imports).
 *
 * 4 lifecycle hooks:
 *   beforeAgent  — runs once before graph starts  (context injection, counter reset)
 *   beforeModel  — runs before each LLM call       (tool policy enforcement)
 *   afterModel   — runs after each LLM call        (stuck detector)
 *   afterAgent   — runs once after graph finishes  (PII redaction on logs/traces)
 */

// ─── Run counters ─────────────────────────────────────────────────────────────

export interface RunCounters {
    tool_errors: number;
    retries: number;
    loop_count: number;
}

// ─── MiddlewareContext ────────────────────────────────────────────────────────

export interface MiddlewareContext {
    /** studentId or user key */
    user_key: string;
    thread_id: string;
    request_id: string;

    /** Per-run counters mutated by middleware */
    counters: RunCounters;

    /** Tool allow/deny policy passed from client request options */
    tool_policy?: {
        allow?: string[];
        deny?: string[];
    };

    /** Arbitrary key-value metadata that middleware can attach */
    metadata: Record<string, unknown>;
}

// ─── Middleware interface ──────────────────────────────────────────────────────

export type MiddlewarePhase =
    | 'beforeAgent'
    | 'beforeModel'
    | 'afterModel'
    | 'afterAgent';

export interface AgentMiddleware {
    name: string;

    /**
     * Called once before the graph starts.
     * Use to inject context variables and initialize counters.
     */
    beforeAgent?(ctx: MiddlewareContext): void | Promise<void>;

    /**
     * Called before each LLM model invocation.
     * Return `{ blocked: true, ... }` to short-circuit the call.
     */
    beforeModel?(
        ctx: MiddlewareContext,
        payload: { tool_calls?: Array<{ name: string; args: unknown }> },
    ): void | { blocked: true; code: string; reason: string } | Promise<void | { blocked: true; code: string; reason: string }>;

    /**
     * Called after each LLM model invocation.
     * Return `{ handoff: true, reason }` to trigger graceful handoff.
     */
    afterModel?(
        ctx: MiddlewareContext,
        payload: { tool_errors_this_step: number; node?: string },
    ): void | { handoff: true; reason: string } | Promise<void | { handoff: true; reason: string }>;

    /**
     * Called once after the graph finishes.
     * Use for PII redaction on logs/traces before sending to Langfuse.
     */
    afterAgent?(
        ctx: MiddlewareContext,
        payload: { logs: string[]; traces: Record<string, unknown>[] },
    ): void | Promise<void>;
}

// ─── Factory & runner ─────────────────────────────────────────────────────────

export function createMiddlewareContext(params: {
    user_key: string;
    thread_id: string;
    request_id: string;
    tool_policy?: { allow?: string[]; deny?: string[] };
}): MiddlewareContext {
    return {
        user_key: params.user_key,
        thread_id: params.thread_id,
        request_id: params.request_id,
        counters: { tool_errors: 0, retries: 0, loop_count: 0 },
        tool_policy: params.tool_policy,
        metadata: {},
    };
}

export async function runMiddlewarePhase<P extends MiddlewarePhase>(
    stack: AgentMiddleware[],
    phase: P,
    ctx: MiddlewareContext,
    payload?: unknown,
): Promise<unknown> {
    for (const mw of stack) {
        const fn = mw[phase] as
            | ((ctx: MiddlewareContext, payload?: unknown) => unknown)
            | undefined;
        if (fn) {
            const result = await fn.call(mw, ctx, payload);
            // If any middleware returns a blocking/handoff signal → propagate
            if (result && typeof result === 'object' && ('blocked' in result || 'handoff' in result)) {
                return result;
            }
        }
    }
    return undefined;
}
