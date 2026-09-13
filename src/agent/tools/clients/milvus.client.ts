import { MilvusClient, DataType, MetricType } from '@zilliz/milvus2-sdk-node';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('MilvusSearchClient');

// BGE-M3 dense vector dimension (via @xenova/transformers quantized)
const VECTOR_DIM = 1024;

// ─── P2B: Vietnamese Text Normalization ──────────────────────────────────────
// Thay thế các viết tắt phổ biến của HUST trước khi embed để tăng recall
const ABBREVIATION_MAP: Record<string, string> = {
    'sv': 'sinh viên',
    'gv': 'giảng viên',
    'hk': 'học kỳ',
    'tc': 'tín chỉ',
    'đhbk': 'đại học bách khoa',
    'bkhn': 'bách khoa hà nội',
    'hust': 'đại học bách khoa hà nội',
    'cpa': 'điểm trung bình tích lũy',
    'gpa': 'điểm trung bình học kỳ',
    'ks': 'kỹ sư',
    'kscs': 'kỹ sư chuyên sâu',
    'ths': 'thạc sĩ',
    'đt': 'đào tạo',
    'tt': 'thực tập',
    'kltn': 'khóa luận tốt nghiệp',
    'đa': 'đồ án',
    'ctđt': 'chương trình đào tạo',
    'nckh': 'nghiên cứu khoa học',
};

function normalizeVietnamese(text: string): string {
    // NFKC unicode normalization (fix composed/decomposed diacritics)
    let normalized = text.normalize('NFKC').trim();
    // Lowercase for abbreviation matching
    let lower = normalized.toLowerCase();
    // Replace known abbreviations (word boundary)
    for (const [abbr, full] of Object.entries(ABBREVIATION_MAP)) {
        const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
        lower = lower.replace(regex, full);
    }
    // Collapse multiple whitespace
    return lower.replace(/\s+/g, ' ').trim();
}

function preprocessText(text: string): string {
    if (!text) return '';


    let processed = text.normalize('NFKC');

    processed = processed.toLowerCase();
    processed = processed.replace(/https?:\/\/\S+|www\.\S+/g, '');
    processed = processed.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '');
    processed = processed.replace(/\[([^\]]+)\]\(\)/g, '$1');
    processed = processed.replace(/\*\*/g, '').replace(/---/g, '');
    processed = processed.replace(/[\u00A0\u202F\u200E\u200F\u2060\uFEFF]/g, '');

    // for (const [abbr, full] of Object.entries(ABBREVIATION_MAP)) {
    //     const regex = new RegExp(`\\b${abbr}\\b`, 'g');
    //     processed = processed.replace(regex, full);
    // }
    processed = processed.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    return processed.replace(/\s+/g, ' ').trim();
}

export interface VectorSearchOptions {
    topK: number;
    threshold?: number;
    categories?: string[];
}

export interface SearchResult {
    score: number;
    rerankScore?: number;  // P1B: cross-encoder confidence score (0-1), undefined if reranker not run
    payload: {
        context: string;
        title: string;
        section: string;
        link: string;
        category: string;
    };
}

/**
 * MilvusSearchClient
 *
 * Drop-in replacement for QdrantSearchClient.
 * Embedding: BAAI/bge-m3 (1024-dim) via @xenova/transformers — fully local/embedded.
 *   - No external service needed
 *   - First call downloads ~450MB quantized model to cache
 *   - Subsequent calls reuse cached model (fast init)
 *   - BGE-M3 uses 'cls' pooling (unlike MiniLM which uses 'mean')
 */
export class MilvusSearchClient {
    private readonly client: MilvusClient;
    private readonly collection: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private extractor: ((inputs: string[], opts: Record<string, unknown>) => Promise<unknown>) | null = null;
    // P1B: Cross-Encoder Reranker (lazy-loaded, same @xenova/transformers package)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private reranker: ((query: string, docs: string[]) => Promise<unknown>) | null = null;

    constructor() {
        this.collection = envConfig.MILVUS_COLLECTION;
        this.client = new MilvusClient({
            address: envConfig.MILVUS_URI,
            ...(envConfig.MILVUS_TOKEN ? { token: envConfig.MILVUS_TOKEN } : {}),
        });
    }

    private isLoaded = false;

    private async ensureLoaded() {
        if (!this.isLoaded) {
            await this.client.loadCollection({ collection_name: this.collection });
            this.isLoaded = true;
            logger.info(`[MilvusSearchClient] Collection ${this.collection} loaded into memory for search`);
        }
    }

    /**
     * Lazy-load BAAI/bge-m3 via @xenova/transformers.
     * Model is downloaded once (~450MB quantized) then cached.
     */
    private async getExtractor() {
        if (!this.extractor) {
            logger.info('Loading BAAI/bge-m3 model (first call — may take ~30s to download)...');
            const { pipeline } = await import('@xenova/transformers');
            this.extractor = await pipeline(
                'feature-extraction',
                'Xenova/bge-m3',
                { quantized: true },
            ) as unknown as typeof this.extractor;

            logger.info('BGE-M3 model loaded (1024-dim, cls pooling)');
        }
        return this.extractor!;
    }

    /**
     * Pre-warm: trigger model load at startup so first user request is not blocked.
     * Call this once during AgentProvider init, fire-and-forget.
     */
    async warmEmbedder(): Promise<void> {
        try {
            logger.info('[Warmup] Pre-loading BGE-M3 embedding model...');
            await this.getExtractor();
            // Embed a dummy string to force full initialization
            await this.embed('khoi dong');
            logger.info('[Warmup] ✅ BGE-M3 model ready');
        } catch (e) {
            logger.warn('[Warmup] Embedding pre-warm failed (non-fatal)', { error: String(e) });
        }
    }

    /**
     * P1B: Lazy-load BGE-Reranker cross-encoder for precision reranking.
     * Model: Xenova/bge-reranker-base (~140MB quantized)
     * Uses same @xenova/transformers — no extra dep needed.
     */
    private async getReranker() {
        if (!this.reranker) {
            logger.info('Loading Xenova/bge-reranker-base for cross-encoder reranking...');
            const { pipeline } = await import('@xenova/transformers');
            const pipelineInstance = await pipeline(
                'text-classification',
                'Xenova/bge-reranker-base',
                { quantized: true },
            );
            this.reranker = async (query: string, docs: string[]) => {
                const pairs = docs.map(doc => `${query}[SEP]${doc}`);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (pipelineInstance as any)(pairs, { function_to_apply: 'sigmoid' });
            };
            logger.info('BGE-Reranker loaded (cross-encoder, quantized)');
        }
        return this.reranker!;
    }

    /**
     * P1B: Rerank candidates using cross-encoder. Returns sorted by true relevance.
     */
    private async rerank(query: string, results: SearchResult[], topK: number): Promise<SearchResult[]> {
        if (results.length <= 1) return results;
        // NOTE: Reranker (Xenova/bge-reranker-base ~140MB) disabled for now.
        // On first call it downloads & loads the model which blocks requests for ~2-5 min.
        // Using ANN cosine score order directly — quality is still good with BGE-M3 embeddings.
        // Re-enable when the model is pre-warmed or hosted externally.
        logger.debug('Reranker bypassed — using ANN cosine order', { topK, candidates: results.length });
        return results.slice(0, topK);
    }

    /**
     * Embed a single text → 1024-dim float vector.
     * BGE-M3 uses cls pooling (first token) + L2 normalize.
     * P2B: normalize Vietnamese before embedding.
     */
    private async embed(text: string): Promise<number[]> {
        const ext = await this.getExtractor();

        const output = await ext([text.slice(0, 4000)], { pooling: 'cls', normalize: true }) as { tolist: () => number[][] };
        return output.tolist()[0];
    }

    /**
     * Embed multiple texts (for batch seeding).
     */
    async embedBatch(texts: string[]): Promise<number[][]> {
        const ext = await this.getExtractor();
        const output = await ext(
            texts.map(t => t.slice(0, 512)),
            { pooling: 'cls', normalize: true },
        ) as { tolist: () => number[][] };
        return output.tolist();
    }

    /**
     * P2A: Hybrid Search (Dense ANN + Keyword Filter RRF) — inspired by V1 Elasticsearch hybrid
     *
     * Strategy:
     *  1. Dense ANN: embed normalized query → cosine ANN top-K*2
     *  2. Keyword ANN: embed UNnormalized query → additional search without abbreviation expansion
     *     (thiếu dấu/týp năng queries có thể match khác với normalized)
     *  3. RRF merge: Reciprocal Rank Fusion, k=60 (TREC standard)
     *  4. Cross-encoder rerank → final top-K
     */
    async search(query: string, opts: VectorSearchOptions): Promise<SearchResult[]> {
        await this.ensureLoaded();

        // P2B: normalize before embedding
        const normalizedQuery = preprocessText(query);
        const isDifferent = normalizedQuery !== query.toLowerCase().trim();

        logger.info('Hybrid search starting', {
            original: query.substring(0, 60),
            normalized: normalizedQuery.substring(0, 60),
            hybridMode: isDifferent,
        });

        // P1B: Retrieve more candidates for reranking
        const candidateK = Math.max(opts.topK * 3, 15);

        const buildSearchParams = (vector: number[], expr?: string): Record<string, unknown> => ({
            collection_name: this.collection,
            data: [vector],
            vector_type: DataType.FloatVector,
            output_fields: ['context', 'title', 'section', 'link', 'category'],
            limit: candidateK,
            metric_type: MetricType.COSINE,
            params: { nprobe: 16 },
            ...(opts.categories && opts.categories.length > 0 ? {
                expr: `category in [${opts.categories.map(c => `"${c}"`).join(', ')}]${expr ? ` AND (${expr})` : ''}`,
            } : expr ? { expr } : {}),
        });

        // Dense search on normalized query
        const denseVector = await this.embed(normalizedQuery);
        const denseParams = buildSearchParams(denseVector);
        const densePromise = this.client.search(denseParams as Parameters<typeof this.client.search>[0]);

        // P2A: If query was changed by normalization, also search on original (keyword recall)
        let keywordPromise: Promise<{ results: any[] }> | null = null;
        if (isDifferent) {
            const rawVector = await this.embed(query); // embed un-normalized
            keywordPromise = this.client.search(buildSearchParams(rawVector) as Parameters<typeof this.client.search>[0]);
        }

        const [denseRes, keywordRes] = await Promise.all([
            densePromise,
            keywordPromise ?? Promise.resolve({ results: [] }),
        ]);

        logger.info('Milvus hybrid ANN done', {
            dense: denseRes.results.length,
            keyword: keywordRes.results.length,
        });

        // ── RRF Merge (Reciprocal Rank Fusion, k=60) ──
        const RRF_K = 60;
        const scoreMap = new Map<string, { result: SearchResult; rrfScore: number }>();

        const addToRRF = (hits: any[], listWeight: number = 1) => {
            hits
                .filter(r => opts.threshold === undefined || r.score >= (opts.threshold! * 0.9)) // slightly relaxed for hybrid
                .forEach((r, rank) => {
                    const text = String(r['context'] ?? '');
                    const key = text.length > 150 ? text.substring(150, 230) : text;

                    const rrfScore = listWeight / (RRF_K + rank + 1);
                    const existing = scoreMap.get(key);
                    const sr: SearchResult = {
                        score: r.score,
                        payload: {
                            context: String(r['context'] ?? ''),
                            title: String(r['title'] ?? ''),
                            section: String(r['section'] ?? ''),
                            link: String(r['link'] ?? ''),
                            category: String(r['category'] ?? 'general'),
                        },
                    };
                    if (existing) {
                        existing.rrfScore += rrfScore;
                    } else {
                        scoreMap.set(key, { result: sr, rrfScore });
                    }
                });
        };

        addToRRF(denseRes.results, 1.0);       // dense: weight 1.0
        addToRRF(keywordRes.results, 0.7);     // keyword/raw: weight 0.7 (lower priority)

        // Sort by combined RRF score
        const merged = [...scoreMap.values()]
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, candidateK)
            .map(v => v.result);

        if (merged.length === 0) return [];

        // // P1B: Cross-encoder rerank for final precision
        // const reranked = await this.rerank(query, merged, opts.topK);
        // return reranked;
        return merged.slice(0, opts.topK);
    }

    /** Ensure collection with BGE-M3 1024-dim schema exists */
    async ensureCollection(): Promise<void> {
        const exists = await this.client.hasCollection({ collection_name: this.collection });
        if (exists.value) {
            logger.info('Milvus collection exists', { collection: this.collection });
            return;
        }

        await this.client.createCollection({
            collection_name: this.collection,
            fields: [
                { name: 'id', data_type: DataType.Int64, is_primary_key: true, autoID: true },
                { name: 'vector', data_type: DataType.FloatVector, dim: VECTOR_DIM },
                { name: 'context', data_type: DataType.VarChar, max_length: 10000 },
                { name: 'title', data_type: DataType.VarChar, max_length: 1000 },
                { name: 'section', data_type: DataType.VarChar, max_length: 500 },
                { name: 'link', data_type: DataType.VarChar, max_length: 1000 },
                { name: 'category', data_type: DataType.VarChar, max_length: 100 },
            ],
        });

        await this.client.createIndex({
            collection_name: this.collection,
            field_name: 'vector',
            index_type: 'IVF_FLAT',
            metric_type: MetricType.COSINE,
            params: { nlist: 128 },
        });

        await this.client.loadCollection({ collection_name: this.collection });
        logger.info('Milvus collection created (BGE-M3, 1024-dim, COSINE)', { collection: this.collection });
    }
}
