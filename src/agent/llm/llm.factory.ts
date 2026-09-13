import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { envConfig } from '@/common/config/env.config';

export type ThinkingLevel =
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high';

export type ModelEntry = {
    provider: 'gemini';
    model: string;          // Tên model gọi trực tiếp qua Google (vd: gemini-3.1-flash-lite)
    liteLlmModel?: string;  // Tên model gọi qua LiteLLM (vd: gemini/gemini-2.5-flash-hustva-dev)
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;

    thinking?: {
        level: ThinkingLevel;
    } | false;
};

export type LlmRegistry = {
    defaultKey: string;
    models: Record<string, ModelEntry>;
};

export class LlmFactory {

    private cache =
        new Map<string, BaseChatModel>();

    constructor(
        private readonly registry: LlmRegistry,
    ) { }

    /**
     * @param key Mặc định là 'compose'
     * @param overrideThinking Cho phép ghi đè cấu hình tư duy khi cần thiết
     */
    getModel(key?: string, overrideThinking?: ModelEntry['thinking']): BaseChatModel {
        const resolvedKey = key ?? this.registry.defaultKey;

        const entry = this.registry.models[resolvedKey];
        if (!entry) throw new Error(`[LlmFactory] Model key "${resolvedKey}" not found`);

        const finalThinking: any = overrideThinking !== undefined ? overrideThinking : entry.thinking;

        const thinkingCacheKey = finalThinking === false ? 'none' : finalThinking.level;
        const cacheKey = `${resolvedKey}_thinking_${thinkingCacheKey}`;

        const cached =
            this.cache.get(cacheKey);

        if (cached) {
            return cached;
        }

        let thinkingConfig: any = undefined;

        /**
         * Disable thinking
         */
        if (finalThinking === false) {
            thinkingConfig = { thinkingBudget: 0 };
        } else {
            thinkingConfig = {
                thinkingLevel: finalThinking.level,
            };
        }

        const useLiteLLM = envConfig.USE_LITELLM;
        let model: BaseChatModel;

        if (useLiteLLM) {
            model = new ChatOpenAI({
                modelName: entry.liteLlmModel,
                temperature: entry.temperature,
                maxTokens: entry.maxOutputTokens,
                topP: entry.topP ?? 0.95,
                configuration: {
                    baseURL: envConfig.LITELLM_BASE_URL,
                    apiKey: envConfig.LITELLM_API_KEY || "sk-dummy-key",
                },
                modelKwargs: {
                    thinkingConfig: thinkingConfig
                }
            });
        } else {
            model = new ChatGoogleGenerativeAI({
                model: entry.model,
                temperature: entry.temperature,
                maxOutputTokens: entry.maxOutputTokens,
                topP: entry.topP ?? 0.95,
                apiKey: envConfig.GEMINI_API_KEY,
                thinkingConfig: thinkingConfig
            });
        }

        this.cache.set(
            cacheKey,
            model,
        );

        return model;
    }
}

export const DEFAULT_LLM_REGISTRY: LlmRegistry = {
    defaultKey: 'compose',
    models: {
        react: {
            provider: 'gemini',
            model: envConfig.GEMINI_MODEL,
            liteLlmModel: envConfig.LITELLM_MODEL,
            temperature: envConfig.LLM_TEMPERATURE_REACT,
            maxOutputTokens: envConfig.LLM_MAX_TOKENS,
            thinking: { level: 'minimal' }
        },
        compose: {
            provider: 'gemini',
            model: envConfig.GEMINI_MODEL,
            liteLlmModel: envConfig.LITELLM_MODEL,
            temperature: envConfig.LLM_TEMPERATURE_COMPOSE,
            maxOutputTokens: envConfig.LLM_MAX_TOKENS,
            thinking: { level: 'minimal' }
        },
        flash: {
            provider: 'gemini',
            model: envConfig.GEMINI_MODEL,
            liteLlmModel: envConfig.LITELLM_MODEL,
            temperature: envConfig.LLM_TEMPERATURE_COMPOSE,
            maxOutputTokens: envConfig.LLM_MAX_TOKENS,
            thinking: { level: 'minimal' }
        },
    },
};