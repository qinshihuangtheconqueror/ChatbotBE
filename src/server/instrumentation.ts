/**
 * OpenTelemetry instrumentation — MUST be imported first in main.ts
 * before any other imports (even dotenv).
 *
 * @langfuse/langchain v4 is OTel-native. Without this, all LangChain
 * callback traces are silently discarded.
 *
 * Per official docs: https://langfuse.com/docs/integrations/langchain/tracing
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

// Load .env manually here so LANGFUSE_* vars are available before SDK init
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config();

const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();

// Graceful shutdown on exit
process.on('SIGTERM', async () => {
    await sdk.shutdown();
});
