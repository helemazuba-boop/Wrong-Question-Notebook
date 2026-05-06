/**
 * AI Client abstraction layer.
 *
 * Supports multiple providers via the `AI_PROVIDER` env var:
 *   google      → @google/genai SDK (default)
 *   anthropic   → @anthropic-ai/sdk SDK
 *   openai      → OpenAI-compatible API via fetch
 *
 * All providers expose a normalized `generateContent()` interface that returns
 * `{ text: string }` regardless of the underlying SDK.
 */

import { GoogleGenAI } from '@google/genai';
import { Anthropic } from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { AI_CONSTANTS_TYPE } from '@/lib/constants';

// =====================================================
// Types
// =====================================================

export interface GenerateContentPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

export interface GenerateContentRole {
  role: 'user' | 'model' | 'system';
  parts: GenerateContentPart[];
}

export interface GenerateContentConfig {
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateContentParams {
  model: string;
  contents: GenerateContentRole[];
  config?: GenerateContentConfig;
}

export interface GenerateContentResult {
  text: string;
}

export interface AIClient {
  generateContent(params: GenerateContentParams): Promise<GenerateContentResult>;
}

// =====================================================
// Google Provider
// =====================================================

function createGoogleClient(apiKey: string): AIClient {
  const baseUrl = process.env.AI_PROVIDER_BASE_URL;
  const genai = new GoogleGenAI({
    apiKey,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });

  return {
    async generateContent(params): Promise<GenerateContentResult> {
      const response = await genai.models.generateContent({
        model: params.model,
        contents: params.contents,
        config: {
          systemInstruction: params.config?.systemInstruction,
          responseMimeType: params.config?.responseMimeType,
          responseSchema: params.config?.responseSchema,
          temperature: params.config?.temperature,
          maxOutputTokens: params.config?.maxTokens,
        },
      });
      return { text: response.text ?? '' };
    },
  };
}

// =====================================================
// Anthropic Provider
// =====================================================

function createAnthropicClient(apiKey: string): AIClient {
  const anthropic = new Anthropic({ apiKey });

  return {
    async generateContent(params): Promise<GenerateContentResult> {
      const systemInstruction = params.config?.systemInstruction;

      // Convert GenerateContentRole[] to Anthropic MessageParam[]
      const messages: MessageParam[] = params.contents
        .filter(c => c.role === 'user')
        .map(c => {
          const blocks: ContentBlockParam[] = c.parts
            .map(p => {
              if (p.text) {
                return { type: 'text' as const, text: p.text };
              }
              if (p.inlineData) {
                const mimeMap: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
                  'image/jpeg': 'image/jpeg',
                  'image/png': 'image/png',
                  'image/gif': 'image/gif',
                  'image/webp': 'image/webp',
                };
                return {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: mimeMap[p.inlineData.mimeType] ?? 'image/jpeg',
                    data: p.inlineData.data,
                  },
                } as ContentBlockParam;
              }
              return null;
            })
            .filter((b): b is ContentBlockParam => b !== null);
          return { role: 'user' as const, content: blocks };
        });

      const body: {
        model: string;
        messages: MessageParam[];
        max_tokens: number;
        temperature?: number;
        system?: string;
      } = {
        model: params.model,
        messages,
        max_tokens: params.config?.maxTokens ?? 4096,
        temperature: params.config?.temperature,
      };

      if (systemInstruction) {
        body.system = systemInstruction;
      }

      const response = await anthropic.messages.create(body);

      // Extract text from response content blocks
      const textBlocks = response.content.filter(
        block => block.type === 'text'
      ) as Array<{ type: 'text'; text: string }>;

      const text = textBlocks.map(b => b.text).join('');
      return { text };
    },
  };
}

// =====================================================
// OpenAI-Compatible Provider
// =====================================================

function createOpenAICompatClient(baseUrl: string, apiKey: string): AIClient {
  return {
    async generateContent(params): Promise<GenerateContentResult> {
      type MessageContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
      type OpenAIMessage = { role: string; content: MessageContent[] | string };

      const messages: OpenAIMessage[] = [];

      if (params.config?.systemInstruction) {
        messages.push({
          role: 'system',
          content: params.config.systemInstruction,
        });
      }

      for (const c of params.contents) {
        const contentParts: MessageContent[] = [];
        for (const p of c.parts) {
          if (p.text) {
            contentParts.push({ type: 'text', text: p.text });
          }
          if (p.inlineData) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
              },
            });
          }
        }
        if (contentParts.length > 0) {
          messages.push({ role: c.role, content: contentParts });
        }
      }

      const body: Record<string, unknown> = {
        model: params.model,
        messages,
        temperature: params.config?.temperature,
        max_tokens: params.config?.maxTokens,
      };

      if (params.config?.responseMimeType === 'application/json') {
        body.response_format = { type: 'json_object', schema: params.config.responseSchema };
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI-compatible API error ${res.status}: ${errText}`);
      }

      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? '';
      return { text };
    },
  };
}

// =====================================================
// Factory
// =====================================================

export type AIProvider = 'google' | 'anthropic' | 'openai';

export function createAIClient(AI_CONSTANTS: AI_CONSTANTS_TYPE): AIClient {
  const provider: AIProvider = AI_CONSTANTS.PROVIDER as AIProvider;

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    return createAnthropicClient(apiKey);
  }

  if (provider === 'openai') {
    const baseUrl = process.env.AI_PROVIDER_BASE_URL;
    const apiKey = process.env.AI_PROVIDER_API_KEY;
    if (!baseUrl) throw new Error('AI_PROVIDER_BASE_URL is not configured');
    if (!apiKey) throw new Error('AI_PROVIDER_API_KEY is not configured');
    return createOpenAICompatClient(baseUrl.trim(), apiKey.trim());
  }

  // Default: google
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  return createGoogleClient(apiKey);
}
