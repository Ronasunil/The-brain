import { env } from "../config/env";
import {
  AIProvider,
  AIProviderName,
  AIProviderConfig,
} from "../lib/types/ai.types";
import { AI_PROVIDER_CONFIGS } from "../lib/constants/app.constants";
import { OpenAIProvider } from "./openai.provider";
import { ZhipuProvider } from "./zhipu.provider";
import { CohereProvider } from "./cohere.provider";

/**
 * Provider Factory — creates the right AI provider based on config.
 *
 * Usage:
 *   const provider = createAIProvider("openai");  // uses OpenAI
 *   const provider = createAIProvider("zhipu");   // uses Zhipu AI (GLM)
 *   const provider = createAIProvider("cohere");  // uses Cohere (free tier)
 *   const provider = createAIProvider();          // uses AI_PROVIDER from .env
 *
 * Adding a new provider:
 * 1. Create src/providers/new.provider.ts implementing AIProvider
 * 2. Add config to AI_PROVIDER_CONFIGS in app.constants.ts
 * 3. Add case to the switch below
 * That's it — no other code changes needed.
 */

let cachedProvider: AIProvider | null = null;

export function createAIProvider(name?: AIProviderName): AIProvider {
  const providerName = name || (env.AI_PROVIDER as AIProviderName);
  const config = getProviderConfig(providerName);

  switch (providerName) {
    case "openai":
      return new OpenAIProvider(config);
    case "zhipu":
      return new ZhipuProvider(config);
    case "cohere":
      return new CohereProvider(config);
    default:
      throw new Error(
        `Unknown AI provider: ${providerName}. Supported: openai, zhipu, cohere`,
      );
  }
}

/**
 * Get or create a singleton provider instance.
 * Used by AIService — avoids creating a new client on every call.
 */
export function getAIProvider(): AIProvider {
  if (!cachedProvider) {
    cachedProvider = createAIProvider();
  }
  return cachedProvider;
}

/**
 * Reset the cached provider (useful for testing or runtime switching).
 */
export function resetAIProvider(): void {
  cachedProvider = null;
}

/**
 * Build provider config from env vars + defaults.
 */
function getProviderConfig(providerName: AIProviderName): AIProviderConfig {
  const defaults = AI_PROVIDER_CONFIGS[providerName];

  // Resolve API key per provider
  let apiKey: string;
  switch (providerName) {
    case "cohere":
      apiKey = env.COHERE_API_KEY!;
      break;
    case "zhipu":
      apiKey = env.ZHIPU_API_KEY || env.OPENAI_API_KEY || "";
      break;
    default:
      apiKey = env.OPENAI_API_KEY || "";
  }

  return {
    apiKey: apiKey!,
    embeddingModel: defaults.embeddingModel,
    embeddingDimensions: defaults.embeddingDimensions,
    chatModel: defaults.chatModel,
    baseURL: defaults.baseURL,
  };
}
