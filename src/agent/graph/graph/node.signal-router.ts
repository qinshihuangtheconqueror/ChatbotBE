/**
 * node.signal-router.ts — Layer 1.5: Embedding & kNN Scorer
 *
 * Position in pipeline:
 * rule_router (~0ms) → [this node] (Embedding, ~80ms) → react.node (Dynamic Pruning)
 *
 * Algorithm — Similarity Scoring:
 * 1. Load intents from intents.json at startup.
 * 2. Warmup: Embed all examples into memory.
 * 3. Query time: Embed user query.
 * 4. Scoring: For EACH intent, find the example with the highest Cosine Similarity to the query.
 * 5. Output: Return an array of scores to State for react.node to prune.
 */
import { OpenAIEmbeddings } from '@langchain/openai';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { LangGraphRunnableConfig } from '@langchain/langgraph';
import { StateAnnotation } from './state';
import { createLogger } from '@/common/logger/logger';
import { envConfig } from '@/common/config/env.config';
import * as path from 'path';
import * as fs from 'fs';

const logger = createLogger('SignalRouter');

// ─── Load intents from intents.json ──────────────────────────────────────────

interface IntentDef {
    intent: string;      // Tên intent (ví dụ: 'chitchat', 'schedule_intent')
    description: string;
    skills: string[];    // Tên skill tương ứng (ví dụ: ['schedule'])
    threshold: number;   // KHÔNG CÒN DÙNG TRONG PIPELINE NÀY, nhưng giữ lại file cấu trúc
    examples: string[];
}

function loadIntents(): IntentDef[] {
    try {
        const candidates = [
            // Đường dẫn gốc trên máy Dev
            path.join(process.cwd(), 'src/common/data/intents.json'), 
            // Đường dẫn trên Production (khi chạy từ dist)
            path.join(process.cwd(), 'dist/common/data/intents.json'),
            // Các dự phòng cũ
            path.join(__dirname, '../../intents.json'),
            path.join(process.cwd(), 'src/agent/intents.json'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf-8');
                logger.info(`Loaded intents from ${p}`);
                return JSON.parse(raw) as IntentDef[];
            }
        }
        logger.warn('intents.json not found — using empty intent list');
        return [];
    } catch (e: any) {
        logger.error('Failed to load intents.json', { error: e.message });
        return [];
    }
}
const INTENT_DEFS: IntentDef[] = loadIntents();

// ─── Math helpers ─────────────────────────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

function norm(v: number[]): number {
    return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosineSimilarity(a: number[], b: number[]): number {
    const n = norm(a) * norm(b);
    return n === 0 ? 0 : dotProduct(a, b) / n;
}

// ─── kNN Store ────────────────────────────────────────────────────────────────

interface ExampleEntry {
    intent: string;
    skills: string[];
    text: string;
    vec: number[];
}

let knnStore: ExampleEntry[] | null = null;
let embeddingModel: OpenAIEmbeddings | GoogleGenerativeAIEmbeddings | null = null;
let warmupPromise: Promise<void> | null = null;

function getEmbeddingModel(): OpenAIEmbeddings | GoogleGenerativeAIEmbeddings {
    if (!embeddingModel) {
        const useLiteLLM = envConfig.USE_LITELLM_EMBEDDING;

        if (useLiteLLM) {
            logger.info('SignalRouter: Khởi tạo OpenAIEmbeddings qua LiteLLM Proxy');
            embeddingModel = new OpenAIEmbeddings({
                modelName: envConfig.LITELLM_EMBEDDING_MODEL, 
                openAIApiKey: envConfig.LITELLM_API_KEY || 'dummy-key',
                
                encodingFormat: "float", 
                
                // THÊM DÒNG NÀY: Ép LangChain chia nhỏ batch để không làm Gemini bị ngợp
                batchSize: 100, // Google giới hạn tối đa 100 requests per batch
                // maxRetries: 3, // Thêm tùy chọn này nếu sợ lỗi mạng chập chờn khi gọi nhiều batch liên tục
                
                configuration: {
                    baseURL: envConfig.LITELLM_BASE_URL,
                    fetch: async (url, options) => {
                        if (options && options.body && typeof options.body === 'string') {
                            try {
                                const bodyObj = JSON.parse(options.body);
                                if (bodyObj.encoding_format) {
                                    delete bodyObj.encoding_format; 
                                }
                                options.body = JSON.stringify(bodyObj);
                            } catch (e) {
                                logger.error('Lỗi khi parse body request trong Embedding Fetch:', e);
                            }
                        }
                        return fetch(url, options);
                    }
                }
            });
        } else {
            logger.info('SignalRouter: Khởi tạo GoogleGenerativeAIEmbeddings (API Key trực tiếp)');
            embeddingModel = new GoogleGenerativeAIEmbeddings({
                model: 'gemini-embedding-001', 
                apiKey: envConfig.GEMINI_API_KEY || '',
            });
        }
    }
    return embeddingModel;
}

async function buildKnnStore(): Promise<void> {
    if (knnStore) return;
    if (INTENT_DEFS.length === 0) {
        knnStore = [];
        return;
    }

    logger.info('Building Signal Router store (one-time warm-up)…');
    const t0 = Date.now();
    const model = getEmbeddingModel();

    const allTexts: string[] = [];
    const meta: Omit<ExampleEntry, 'vec'>[] = [];

    for (const def of INTENT_DEFS) {
        for (const ex of def.examples) {
            allTexts.push(ex);
            meta.push({ intent: def.intent, skills: def.skills, text: ex });
        }
    }

    const allVecs = await model.embedDocuments(allTexts);
    knnStore = allVecs.map((vec, i) => ({ ...meta[i], vec }));

    logger.info(`Signal Router store built in ${Date.now() - t0}ms — ${knnStore?.length || 0} examples from ${INTENT_DEFS.length} intents`);
}

/** Public API: Gọi hàm này ở server.ts (hoặc main.ts) lúc hệ thống khởi động */
export async function warmupSignalRouter(): Promise<void> {
    if (warmupPromise) return warmupPromise;
    warmupPromise = buildKnnStore();
    return warmupPromise;
}

// ─── Similarity Scoring Algorithm ─────────────────────────────────────────────

interface ScoreResult {
    skill: string;
    score: number;
}

async function getSignalScores(query: string): Promise<ScoreResult[]> {
    if (!knnStore) await buildKnnStore();
    if (!knnStore || knnStore.length === 0) return [];

    const model = getEmbeddingModel();
    const [qVec] = await model.embedDocuments([query]);

    // Bản đồ lưu Max Score của từng Skill
    // (Vì 1 intent có thể map với nhiều skill, hoặc mảng skills rỗng là chitchat)
    const scoreMap = new Map<string, number>();

    for (const entry of knnStore) {
        const sim = cosineSimilarity(qVec, entry.vec);
        
        // Nếu skills rỗng, đây là intent Chitchat
        const targetSkills = entry.skills.length > 0 ? entry.skills : ['chitchat'];

        for (const skill of targetSkills) {
            const currentMax = scoreMap.get(skill) || 0;
            if (sim > currentMax) {
                scoreMap.set(skill, sim);
            }
        }
    }

    // Đổ Map ra Array
    const results: ScoreResult[] = [];
    for (const [skill, score] of scoreMap.entries()) {
        results.push({ skill, score });
    }

    return results;
}

// ─── LangGraph Node ───────────────────────────────────────────────────────────

export async function signalRouterNode(
    state: typeof StateAnnotation.State,
    _config?: LangGraphRunnableConfig,
): Promise<Partial<typeof StateAnnotation.State>> {
    
    // Privacy Guard Bypass
    if (state.routing?.intent === 'privacy_blocked') {
        return { signal_scores: [] };
    }

    const query = state.rewritten_query || 
        (typeof state.messages?.at?.(-1)?.content === 'string'
            ? (state.messages.at(-1)!.content as string)
            : '');

    if (!query.trim()) {
        logger.warn('Empty query — skip signal router');
        return { signal_scores: [] };
    }

    const t0 = Date.now();
    try {
        const scores = await getSignalScores(query);
        const ms = Date.now() - t0;

        if (scores.length === 0) {
            logger.warn('Embedding classification returned empty result');
            return { signal_scores: [] };
        }

        // Sắp xếp log cho dễ nhìn (Giảm dần)
        const sortedScores = [...scores].sort((a, b) => b.score - a.score);
        logger.info(
            `[SignalRouter] ${ms}ms — Top 3: ` +
            sortedScores.slice(0, 3).map(s => `${s.skill}(${s.score.toFixed(2)})`).join(' | ')
        );

        // Đẩy điểm vào state cho react.node.ts xử lý
        return {
            signal_scores: scores,
        };

    } catch (err: any) {
        logger.error('SignalRouter failed', { error: err?.message });
        return { signal_scores: [] }; // Nếu lỗi, báo rỗng để ReactNode tự fallback full LLM
    }
}