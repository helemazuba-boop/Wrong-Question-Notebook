import 'server-only';

import type { SkillRetrievalProfile } from './skill-artifact';

export type EmbeddingRole = 'document' | 'query';

export class EmbeddingProviderContractError extends Error {}
export class EmbeddingProviderTransientError extends Error {}

export interface EmbeddingProvider {
  embed(texts: string[], role: EmbeddingRole): Promise<number[][]>;
}

function assertTexts(texts: string[]): void {
  if (
    texts.length === 0 ||
    texts.some(text => typeof text !== 'string' || !text.trim())
  ) {
    throw new EmbeddingProviderContractError(
      'Embedding query must contain non-blank texts'
    );
  }
}

function requestBody(
  profile: SkillRetrievalProfile,
  texts: string[],
  role: EmbeddingRole
): Record<string, unknown> {
  const contract =
    role === 'document' ? profile.document_contract : profile.query_contract;
  return {
    model: profile.model,
    input: { texts },
    parameters: {
      dimension: profile.dimension,
      output_type: contract.output_type,
      text_type: contract.text_type,
      ...(role === 'query' && 'instruct' in contract
        ? { instruct: contract.instruct }
        : {}),
    },
  };
}

function decodeEmbeddings(payload: unknown, expectedRows: number): number[][] {
  if (!payload || typeof payload !== 'object') {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned malformed JSON'
    );
  }
  const response = payload as {
    status_code?: unknown;
    output?: { embeddings?: unknown };
  };
  const statusCode = response.status_code ?? 200;
  if (statusCode !== 200) {
    throw new EmbeddingProviderContractError(
      'Embedding provider rejected the request'
    );
  }
  const rows = response.output?.embeddings;
  if (!Array.isArray(rows)) {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned malformed JSON'
    );
  }
  const byIndex = new Map<number, number[]>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new EmbeddingProviderContractError(
        'Embedding provider returned a malformed row'
      );
    }
    const index = (row as { text_index?: unknown }).text_index;
    const vector = (row as { embedding?: unknown }).embedding;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      !Array.isArray(vector)
    ) {
      throw new EmbeddingProviderContractError(
        'Embedding provider returned a malformed row'
      );
    }
    if (byIndex.has(index)) {
      throw new EmbeddingProviderContractError(
        'Embedding provider returned duplicate indexes'
      );
    }
    byIndex.set(index, vector as number[]);
  }
  if (byIndex.size !== expectedRows) {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned missing indexes'
    );
  }
  return Array.from({ length: expectedRows }, (_value, index) => {
    const vector = byIndex.get(index);
    if (!vector) {
      throw new EmbeddingProviderContractError(
        'Embedding provider returned missing indexes'
      );
    }
    return vector;
  });
}

function normalize(vector: number[], dimension: number): number[] {
  if (vector.length !== dimension) {
    throw new EmbeddingProviderContractError(
      `Embedding dimension mismatch: ${vector.length} != ${dimension}`
    );
  }
  if (vector.some(value => !Number.isFinite(value))) {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned a non-finite vector'
    );
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned a zero vector'
    );
  }
  return vector.map(value => value / norm);
}

async function requestOnce(
  profile: SkillRetrievalProfile,
  endpoint: string,
  token: string,
  texts: string[],
  role: EmbeddingRole
): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody(profile, texts, role)),
      cache: 'no-store',
    });
  } catch {
    throw new EmbeddingProviderTransientError(
      'Embedding provider network request failed'
    );
  }
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new EmbeddingProviderTransientError(
        'Embedding provider temporarily unavailable'
      );
    }
    throw new EmbeddingProviderContractError(
      'Embedding provider rejected the request'
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned malformed JSON'
    );
  }
  return decodeEmbeddings(payload, texts.length);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function createDashScopeEmbeddingProvider(
  profile: SkillRetrievalProfile,
  options: { endpoint?: string; token?: string } = {}
): EmbeddingProvider {
  const token = (options.token ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
  const endpoint = (
    options.endpoint ??
    process.env.DASHSCOPE_ENDPOINT ??
    profile.endpoint
  ).trim();
  if (!token || !endpoint) {
    throw new EmbeddingProviderContractError(
      'Protected DashScope API key or endpoint is not configured'
    );
  }
  return {
    async embed(texts: string[], role: EmbeddingRole): Promise<number[][]> {
      assertTexts(texts);
      let vectors: number[][] | null = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          vectors = await requestOnce(profile, endpoint, token, texts, role);
          break;
        } catch (error) {
          if (
            !(error instanceof EmbeddingProviderTransientError) ||
            attempt === 3
          ) {
            throw error;
          }
          await sleep(250 * 2 ** attempt);
        }
      }
      if (!vectors) {
        throw new EmbeddingProviderTransientError(
          'Embedding provider retry budget exhausted'
        );
      }
      return vectors.map(vector => normalize(vector, profile.dimension));
    },
  };
}
