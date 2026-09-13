/**
 * Stuck Detector Middleware
 *
 * Runs after each model call (afterModel phase).
 * Increments tool-failure and loop counters.
 * When thresholds are exceeded: returns a handoff signal to break the loop.
 *
 * Thresholds (configurable):
 *   maxToolFailures: 3  — consecutive tool errors before giving up
 *   maxLoops:        5  — total reasoning iterations before giving up
 */
import { AgentMiddleware, MiddlewareContext } from './types';

export interface StuckDetectorConfig {
    /** Maximum consecutive tool failures before signalling handoff (default: 3) */
    maxToolFailures: number;
    /** Maximum reasoning loops before signalling handoff (default: 5) */
    maxLoops: number;
}

const DEFAULT_CONFIG: StuckDetectorConfig = {
    maxToolFailures: 3,
    maxLoops: 5,
};

export function createStuckDetectorMiddleware(
    config: Partial<StuckDetectorConfig> = {},
): AgentMiddleware {
    const merged = { ...DEFAULT_CONFIG, ...config };

    return {
        name: 'stuck-detector',

        afterModel(
            ctx: MiddlewareContext,
            payload: { tool_errors_this_step: number; node?: string },
        ): void | { handoff: true; reason: string } {
            ctx.counters.tool_errors += (payload.tool_errors_this_step || 0);
            ctx.counters.loop_count += 1;

            if (ctx.counters.tool_errors >= merged.maxToolFailures) {
                return {
                    handoff: true,
                    reason: `Agent stuck: ${ctx.counters.tool_errors} tool failures exceeded threshold (${merged.maxToolFailures}). Stopping.`,
                };
            }

            if (ctx.counters.loop_count >= merged.maxLoops) {
                return {
                    handoff: true,
                    reason: `Agent stuck: ${ctx.counters.loop_count} reasoning loops exceeded threshold (${merged.maxLoops}). Stopping.`,
                };
            }

            return;
        },
    };
}
