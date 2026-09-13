/**
 * No-op Tracing Adapter
 *
 * Used when tracing is explicitly disabled (TRACING_PROVIDER=none).
 * Always returns undefined — no callbacks are attached to LangChain graph.
 */
import type { TracingContext, TracingProvider } from './tracing.port';

export class NoopTracingProvider implements TracingProvider {
    readonly name = 'noop';

    createCallbackHandler(_ctx: TracingContext): undefined {
        return undefined;
    }
}
