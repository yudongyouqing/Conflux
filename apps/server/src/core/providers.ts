import type { LanguageModel } from "ai" with { "resolution-mode": "import" };
import type { ModelConfig } from "@muiltchat/shared";

export interface ProviderEntry {
  /** Environment variable that unlocks this provider. */
  envVar: string;
  hasKey: () => boolean;
  /**
   * Load the LanguageModel lazily — the @ai-sdk/* packages are ESM-only,
   * so they must be dynamically imported from our CommonJS build.
   */
  loadModel: (modelId: string) => Promise<LanguageModel>;
}

/**
 * Provider registry. Adding a provider is one entry here plus its
 * `@ai-sdk/<provider>` dependency — the agent runner, /settings and the
 * chat preflight all derive from this table.
 */
export const providerRegistry: Record<string, ProviderEntry> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    hasKey: () => !!process.env.ANTHROPIC_API_KEY,
    loadModel: async (id) => {
      const { anthropic } = await import("@ai-sdk/anthropic");
      return anthropic(id);
    },
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    hasKey: () => !!process.env.OPENAI_API_KEY,
    loadModel: async (id) => {
      const { openai } = await import("@ai-sdk/openai");
      return openai(id);
    },
  },
};

/** Check if the API key for a provider is available. */
export function hasApiKey(provider: string): boolean {
  return providerRegistry[provider]?.hasKey() ?? false;
}

/**
 * Resolve a LanguageModel from an agent's model_config. Throws with a
 * precise message when the provider is unknown or its key is missing —
 * the HTTP layer turns this into an SSE/503 error.
 */
export async function resolveModel(config: ModelConfig): Promise<LanguageModel> {
  const entry = providerRegistry[config.provider];
  if (!entry) {
    const supported = Object.keys(providerRegistry).join(", ");
    throw new Error(`unsupported provider: ${config.provider} (supported: ${supported})`);
  }
  if (!entry.hasKey()) {
    throw new Error(`${entry.envVar} is not set — cannot use provider "${config.provider}"`);
  }
  return entry.loadModel(config.model);
}
