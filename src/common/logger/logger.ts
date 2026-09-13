/** Minimal structured logger — drop-in for any logging backend. */
export function createLogger(context: string) {
    const ts = () => new Date().toISOString();
    const prefix = (level: string) => `[${ts()}] [${level}] [${context}]`;
    return {
        info: (msg: string, meta?: Record<string, unknown>) => console.log(`${prefix('INFO')} ${msg}`, meta ?? ''),
        warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`${prefix('WARN')} ${msg}`, meta ?? ''),
        error: (msg: string, err?: unknown, meta?: Record<string, unknown>) =>
            console.error(`${prefix('ERROR')} ${msg}`, { error: String(err), ...meta }),
        debug: (msg: string, meta?: Record<string, unknown>) => {
            if (process.env.NODE_ENV !== 'production') console.debug(`${prefix} ${msg}`, meta ?? '');
        },
    };
}
