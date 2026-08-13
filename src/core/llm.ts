import Anthropic from "@anthropic-ai/sdk";
import type { ModelConfig } from "./agents.js";
import { logger } from "../log.js";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMStreamInput {
  systemPrompt: string;
  messages: LLMMessage[];
  modelConfig: ModelConfig;
}

/**
 * Provider abstraction. Currently only Anthropic is implemented.
 * To add OpenAI: implement this interface with the OpenAI SDK.
 */
export interface LLMProvider {
  stream(input: LLMStreamInput): AsyncGenerator<string, void, unknown>;
}

/** Check if the API key for a provider is available. */
export function hasApiKey(provider: string): boolean {
  switch (provider) {
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    default:
      return false;
  }
}

/** Create the appropriate provider, or throw if unsupported / missing key. */
export function createProvider(provider: string): LLMProvider {
  switch (provider) {
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      return new AnthropicProvider(key);
    }
    default:
      throw new Error(`unsupported provider: ${provider}`);
  }
}

class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *stream(input: LLMStreamInput): AsyncGenerator<string, void, unknown> {
    const maxTokens = input.modelConfig.max_tokens ?? 4096;

    logger.debug(
      { model: input.modelConfig.model, maxTokens, messageCount: input.messages.length },
      "LLM stream request"
    );

    const stream = this.client.messages.stream({
      model: input.modelConfig.model,
      max_tokens: maxTokens,
      system: input.systemPrompt,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}
