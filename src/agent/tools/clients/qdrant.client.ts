import { QdrantClient } from '@qdrant/js-client-rest';
import { envConfig } from '@/common/config/env.config';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('QdrantSearchClient');

export interface QdrantSearchOptions {
    topK: number;
    threshold?: number;
    categories?: string[];
}

export interface SearchResult {
    score: number;
    payload: {
        context: string;
        title: string;
        section: string;
        link: string;
        category: string;
    };
}

export class QdrantSearchClient {
    private readonly client: QdrantClient;
    private readonly collection: string;
    private extractor: any = null; // lazy-loaded local model

    constructor() {
        this.collection = envConfig.QDRANT_COLLECTION;
        this.client = new QdrantClient({
            url: envConfig.QDRANT_URL,
            checkCompatibility: false,
            ...(envConfig.QDRANT_API_KEY ? { apiKey: envConfig.QDRANT_API_KEY } : {}),
        });
    }

    /**
     * Lazy-load @xenova/transformers all-MiniLM-L6-v2 (384d, offline, quantized).
     * First call downloads ~25MB model to cache; subsequent calls reuse.
     */
    private async getExtractor() {
        if (!this.extractor) {
            const { pipeline } = await import('@xenova/transformers');
            this.extractor = await pipeline(
                'feature-extraction',
                'Xenova/all-MiniLM-L6-v2',
                { quantized: true },
            );
            logger.info('Embedding model loaded (all-MiniLM-L6-v2, 384d)');
        }
        return this.extractor;
    }

    async search(query: string, opts: QdrantSearchOptions): Promise<SearchResult[]> {
        logger.info('Embedding query', { query: query.substring(0, 60) });

        const ext = await this.getExtractor();
        const output = await ext([query], { pooling: 'mean', normalize: true });
        const vector: number[] = output.tolist()[0];

        const filter = opts.categories && opts.categories.length > 0
            ? { must: [{ key: 'category', match: { any: opts.categories } }] }
            : undefined;

        const results = await this.client.search(this.collection, {
            vector,
            limit: opts.topK,
            score_threshold: opts.threshold,
            filter,
            with_payload: true,
        });

        logger.info('Qdrant search done', { found: results.length });
        return results.map(r => ({
            score: r.score,
            payload: r.payload as SearchResult['payload'],
        }));
    }

    async ensureCollection(): Promise<void> {
        const exists = await this.client.collectionExists(this.collection);
        if (!exists.exists) {
            await this.client.createCollection(this.collection, {
                vectors: { size: 384, distance: 'Cosine' },
            });
            await this.client.createPayloadIndex(this.collection, {
                field_name: 'category',
                field_schema: 'keyword',
            });
            logger.info('Collection created', { collection: this.collection });
        }
    }
}
