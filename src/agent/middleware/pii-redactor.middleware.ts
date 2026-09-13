/**
 * PII Redaction Middleware
 *
 * Runs after the agent completes (afterAgent phase).
 * Scans log strings and trace objects for PII patterns and redacts them
 * before they are sent to Langfuse or any logging sink.
 *
 * Does NOT modify the user-facing answer text.
 *
 * Patterns covered:
 *   - Email addresses
 *   - Vietnamese phone numbers (0xx, +84xx, 84xx)
 *   - International phone numbers (+XXXXXXXX)
 *   - Vietnamese CCCD (12 digits)
 *   - Credit card numbers
 */
import { AgentMiddleware, MiddlewareContext } from './types';

// ─── PII patterns ─────────────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
    {
        name: 'email',
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        replacement: '[EMAIL_REDACTED]',
    },
    {
        name: 'phone_vn',
        // Vietnamese phone numbers: +84, 0xx, 84xx formats
        regex: /(?:\+?84|0)(?:\d[\s.-]?){8,10}\d/g,
        replacement: '[PHONE_REDACTED]',
    },
    {
        name: 'phone_intl',
        // International phone with + prefix
        regex: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
        replacement: '[PHONE_REDACTED]',
    },
    {
        name: 'vietnamese_cccd',
        // Vietnamese citizen ID (CCCD): 12 digits
        regex: /\b\d{12}\b/g,
        replacement: '[ID_REDACTED]',
    },
    {
        name: 'credit_card',
        // Basic credit card patterns (Visa, MC, etc.)
        regex: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
        replacement: '[CARD_REDACTED]',
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function redactPii(text: string): string {
    let result = text;
    for (const pattern of PII_PATTERNS) {
        result = result.replace(pattern.regex, pattern.replacement);
    }
    return result;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            result[key] = redactPii(value);
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            result[key] = redactObject(value as Record<string, unknown>);
        } else if (Array.isArray(value)) {
            result[key] = value.map((item) =>
                typeof item === 'string'
                    ? redactPii(item)
                    : typeof item === 'object' && item !== null
                        ? redactObject(item as Record<string, unknown>)
                        : item,
            );
        } else {
            result[key] = value;
        }
    }
    return result;
}

// ─── Middleware ────────────────────────────────────────────────────────────────

export const piiRedactorMiddleware: AgentMiddleware = {
    name: 'pii-redactor',

    afterAgent(
        _ctx: MiddlewareContext,
        payload: { logs: string[]; traces: Record<string, unknown>[] },
    ): void {
        // Redact PII from all log strings (in-place)
        for (let i = 0; i < payload.logs.length; i++) {
            payload.logs[i] = redactPii(payload.logs[i]);
        }
        // Redact PII from trace objects (in-place)
        for (let i = 0; i < payload.traces.length; i++) {
            payload.traces[i] = redactObject(payload.traces[i]);
        }
    },
};
