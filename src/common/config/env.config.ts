import { ParseBoolPipe } from "@nestjs/common";

/**
 * Typed environment configuration — single source of truth.
 * Import envConfig instead of using process.env directly.
 */
export const envConfig = {
    // ─── App ──────────────────────────────────────────────────────────────
    PORT: parseInt(process.env.PORT || '3000', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    SERVICE_NAME: process.env.SERVICE_NAME || 'HustVA-V3',

    // ─── HUST eHUST API ───────────────────────────────────────────────────
    HUST_BASE_API_URL: process.env.HUST_BASE_API_URL || 'https://api-dot-hust-edu.appspot.com/partner/api',
    HUST_API_TOKEN: process.env.HUST_API_TOKEN || '',
    HUST_AUTHORIZATION_TOKEN: process.env.HUST_AUTHORIZATION_TOKEN || '',
    HUST_JSESSIONID: process.env.HUST_JSESSIONID || '',  // Session cookie for /student/info

    // ─── HUST DB Public API ───────────────────────────────────────────────
    EHUST_DB_API_URL: process.env.EHUST_DB_API_URL || 'https://e.hust.edu.vn/db-api/public-api',
    EHUST_DB_API_TOKEN: process.env.EHUST_DB_API_TOKEN || 'Bearer 3c23686a26556bdb5100fed58783',

    // ─── LLM Provider ─────────────────────────────────────────────────────
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    REWRITE_MODEL: process.env.REWRITE_MODEL || 'gemini-2.5-flash-lite',
    LLM_TEMPERATURE_REACT: parseFloat(process.env.LLM_TEMPERATURE_REACT || '0.2'),
    LLM_TEMPERATURE_ANSWER: parseFloat(process.env.LLM_TEMPERATURE_ANSWER || '0.1'),
    LLM_TEMPERATURE_REWRITE: parseFloat(process.env.LLM_TEMPERATURE_REWRITE || '0.1'),
    LLM_TEMPERATURE_COMPOSE: parseFloat(process.env.LLM_TEMPERATURE_COMPOSE || '0.5'),
    LLM_MAX_TOKENS: parseInt(process.env.LLM_MAX_TOKENS || '8192', 10),

    // ─── MongoDB ───────────────────────────────────────────────────────────
    MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017/hustva_v3',

    // ─── Milvus (replaces Qdrant) ──────────────────────────────────────────
    MILVUS_URI: process.env.MILVUS_URI || 'http://localhost:19530',
    MILVUS_TOKEN: process.env.MILVUS_TOKEN || '',   // API key for Zilliz Cloud
    MILVUS_COLLECTION: process.env.MILVUS_COLLECTION || 'hust_knowledge',

    // ─── Embedding — BGE-M3 via HuggingFace TEI (GPU) ──────────────────────
    // POST http://localhost:8080/embed → float[][]
    EMBEDDING_API_URL: process.env.EMBEDDING_API_URL || 'http://localhost:8080',

    // ─── Qdrant (legacy — kept for backward compat, can remove after reseed) ─
    QDRANT_URL: process.env.QDRANT_URL || 'http://localhost:6333',
    QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || 'hust_knowledge',
    QDRANT_API_KEY: process.env.QDRANT_API_KEY || '',

    // ─── Neo4j ─────────────────────────────────────────────────────────────
    NEO4J_URI: process.env.NEO4J_URI || 'bolt://localhost:7687',
    NEO4J_USER: process.env.NEO4J_USER || 'neo4j',
    NEO4J_PASSWORD: process.env.NEO4J_PASSWORD || '',

    // ─── Redis ─────────────────────────────────────────────────────────────
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

    // ─── Langfuse / Tracing ────────────────────────────────────────────────
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY || '',
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY || '',
    LANGFUSE_HOST: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
    /** 'langfuse' | 'none' — controls which TracingProvider is used */
    TRACING_PROVIDER: (process.env.TRACING_PROVIDER || 'langfuse') as 'langfuse' | 'none',

    // ─── Auth ──────────────────────────────────────────────────────────────
    JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-prod',

    // ─── CORS ─────────────────────────────────────────────────────────────
    /** Comma-separated allowed origins, e.g. 'http://localhost:80,https://dev-hustva.vbeecore.com' */
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:80,http://localhost:3000,http://localhost:8080',

    // ─── Microsoft OAuth2 (HUST Email Login) ──────────────────────────────
    // App registration: Azure Portal → App registrations
    MS_CLIENT_ID: process.env.MS_CLIENT_ID || 'adcd2204-19d4-4e37-915b-391328dd362c',
    MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET || '',
    // 'common' = any Microsoft account (dev/test). Set tenant ID for org-only.
    MS_TENANT_ID: process.env.MS_TENANT_ID || 'common',

    // ─── Prompts ───────────────────────────────────────────────────────────
    PROMPTS_BASE_DIR: process.env.PROMPTS_BASE_DIR || 'src/agent/prompts',
    PROMPT_INDEX_PATH: process.env.PROMPT_INDEX_PATH || 'src/agent/prompts/index.yaml',
    // ─── HUST API tuning (from V2 teacher_agent) ──────────────────────────
    /** HTTP timeout in ms (V2 default: 30s → 30000) */
    HUST_API_TIMEOUT: parseInt(process.env.HUST_API_TIMEOUT || '30000', 10),
    /** Number of retries on failure (V2 default: 3) */
    HUST_API_RETRY_COUNT: parseInt(process.env.HUST_API_RETRY_COUNT || '3', 10),
    /** Delay between retries in ms (V2 default: 1000ms) */
    HUST_API_RETRY_DELAY: parseInt(process.env.HUST_API_RETRY_DELAY || '1000', 10),
    /** Default semester code used when no semester context (e.g. 20241) */
    HUST_DEFAULT_SEMESTER: process.env.HUST_DEFAULT_SEMESTER || '',
    /** Default program ID for KSCS/program lookups */
    HUST_DEFAULT_PROGRAM_ID: process.env.HUST_DEFAULT_PROGRAM_ID || '',

    // // ─── LLM tuning (from V2 teacher_agent) ───────────────────────────────
    // LLM_TEMPERATURE: parseFloat(process.env.LLM_TEMPERATURE || '0.1'),
    // LLM_MAX_TOKENS: parseInt(process.env.LLM_MAX_TOKENS || '2048', 10),
    // /** Comma-separated fallback models: 'gemini-1.5-flash' or 'model:provider' */
    // LLM_FALLBACK_MODELS: process.env.LLM_FALLBACK_MODELS || '',

    // ─── Cache tuning ──────────────────────────────────────────────────────
    /** Common Redis cache TTL in seconds (V2 default: 3600 = 1h) */
    REDIS_TTL_SECONDS: parseInt(process.env.REDIS_TTL_SECONDS || '3600', 10),

    // RETRIEVAL GATEWAY
    RETRIEVER_API: process.env.RETRIEVER_API || 'http://127.0.0.1:1709/v1/search',
    RETRIEVER_TOKEN: process.env.RETRIEVER_TOKEN || 'Bearer -Go0Fea0jpl8KIGKdBaWBujVj6UROCWUV2ks9XkQmZA',
    /** KMS bot_id — Gateway resolves it to the KB's currently-active version (set via KMS activate). */
    RETRIEVER_BOT_ID: process.env.RETRIEVER_BOT_ID || 'hustva_demo',
    TOP_K_SEARCH: parseInt(process.env.TOP_K_SEARCH || '15', 10),
    TOP_K_RERANK: parseInt(process.env.TOP_K_RERANK || '5', 10),
    NEED_RERANK: (process.env.NEED_RERANK || 'true').toLowerCase() === 'true',
    NEED_REWRITE: (process.env.NEED_REWRITE || 'false').toLowerCase() === 'true',

    // ADMIN TOKEN (for sync curriculum)
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',

    // IMPLEMENT LITELLM
    USE_LITELLM: (process.env.USE_LITELLM || 'false').toLowerCase() === 'true',
    USE_LITELLM_EMBEDDING: (process.env.USE_LITELLM_EMBEDDING || 'false').toLowerCase() === 'true',
    LITELLM_BASE_URL: process.env.LITELLM_BASE_URL || 'https://57a3-103-77-246-45.ngrok-free.app',
    LITELLM_API_KEY: process.env.LITELLM_API_KEY || '',
    LITELLM_MODEL: process.env.LITELLM_MODEL || `gemini/gemini-3.1-flash-lite-hustva-dev`,
    LITELLM_EMBEDDING_MODEL: process.env.LITELLM_EMBEDDING_MODEL || 'gemini-embedding-001',

    SINGLE_AGENT_RATIO: parseFloat(process.env.SINGLE_AGENT_RATIO || '0.7'),  

} as const;

export type EnvConfig = typeof envConfig;
