/**
 * Tracing Factory & Barrel Export
 *
 * Selects the active TracingProvider based on TRACING_PROVIDER env var.
 * Default: 'langfuse'
 * Supported: 'langfuse' | 'none'
 *
 * To add a new provider (e.g. Datadog):
 *   1. Create src/agent/tracing/datadog.adapter.ts implementing TracingProvider
 *   2. Add case 'datadog' below
 */
export type { TracingContext, TracingProvider } from './tracing.port';
export { LangfuseTracingProvider } from './langfuse.adapter';
export { NoopTracingProvider } from './noop.adapter';

import { envConfig } from '@/common/config/env.config';
import { LangfuseTracingProvider } from './langfuse.adapter';
import { NoopTracingProvider } from './noop.adapter';
import type { TracingProvider } from './tracing.port';

export function createTracingProvider(): TracingProvider {
    const provider = envConfig.TRACING_PROVIDER;

    switch (provider) {
        case 'langfuse':
            return new LangfuseTracingProvider();
        case 'none':
            return new NoopTracingProvider();
        default:
            // Backward-compatible: unknown value falls back to Langfuse
            console.warn(
                `[Tracing] Unknown TRACING_PROVIDER "${provider}", falling back to langfuse`,
            );
            return new LangfuseTracingProvider();
    }
}
