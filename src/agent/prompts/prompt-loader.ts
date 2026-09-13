import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('PromptLoader');

interface PromptIndex {
    prompts: Record<string, { file: string; description?: string }>;
}

export class PromptLoader {
    private cache = new Map<string, { text: string; ts: number }>();
    private index: PromptIndex | null = null;
    private readonly ttlMs: number;

    constructor(opts?: { cacheTtlMs?: number }) {
        this.ttlMs = opts?.cacheTtlMs ?? 5 * 60_000;
        this.loadIndex();
    }

    async getPrompt(key: string): Promise<string> {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.ts < this.ttlMs) return cached.text;

        const text = this.readLocal(key);
        if (text) {
            this.cache.set(key, { text, ts: Date.now() });
            return text;
        }
        throw new Error(`[PromptLoader] Prompt "${key}" not found`);
    }

    private loadIndex(): void {
        try {
            const indexPath = envConfig.PROMPT_INDEX_PATH;
            if (fs.existsSync(indexPath)) {
                this.index = yaml.load(fs.readFileSync(indexPath, 'utf-8')) as PromptIndex;
                logger.info('Prompt index loaded', { count: Object.keys(this.index.prompts || {}).length });
            }
        } catch (e) {
            logger.warn('Failed to load prompt index', { error: (e as Error).message });
        }
    }

    private readLocal(key: string): string | null {
        if (!this.index?.prompts?.[key]) return null;
        const filePath = path.resolve(envConfig.PROMPTS_BASE_DIR, this.index.prompts[key].file);
        try { return fs.readFileSync(filePath, 'utf-8'); }
        catch { return null; }
    }
}
