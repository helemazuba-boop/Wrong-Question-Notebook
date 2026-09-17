import 'server-only';

import type { SkillRetrievalProfile } from './skill-artifact';

export type EmbeddingRole = 'document' | 'query';

export class EmbeddingProviderContractError extends Error {}
export class EmbeddingProviderTransientError extends Error {}

export interface EmbeddingProvider {
  embed(texts: string[], role: EmbeddingRole): Promise<number[][]>;
}

export interface EmbeddingProviderOptions {
  endpoint?: string;
  token?: string;
}

type DashscopeProfile = Extract<
  SkillRetrievalProfile,
  { provider_protocol: 'dashscope-qwen37-native-v1' }
>;
type NvidiaProfile = Extract<
  SkillRetrievalProfile,
  { provider_protocol: 'nvidia-query-passage-v1' }
>;

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

// DashScope nests the input and carries protocol knobs under `parameters`;
// rows come back as `output.embeddings[]` keyed by `text_index`.
function dashscopeBody(
  profile: DashscopeProfile,
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

// NVIDIA NIM follows the OpenAI embeddings shape: a flat `input` array and rows
// under `data[]`. There is no `instruct`; `input_type` carries the role.
function nvidiaBody(
  profile: NvidiaProfile,
  texts: string[],
  role: EmbeddingRole
): Record<string, unknown> {
  const contract =
    role === 'document' ? profile.document_contract : profile.query_contract;
  return {
    model: profile.model,
    input: texts,
    input_type: contract.input_type,
    truncate: contract.truncate,
    encoding_format: profile.encoding_format,
  };
}

// The two protocols name the row position differently — DashScope returns
// `text_index`, NVIDIA NIM returns `index` — but both carry the vector as
// `embedding`.
interface IndexedRow {
  embedding: unknown;
}

function extractRows(
  payload: unknown,
  expectedRows: number,
  readRows: (payload: Record<string, unknown>) => unknown,
  indexKey: 'text_index' | 'index'
): number[][] {
  if (!payload || typeof payload !== 'object') {
    throw new EmbeddingProviderContractError(
      'Embedding provider returned malformed JSON'
    );
  }
  const rows = readRows(payload as Record<string, unknown>);
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
    const { embedding: vector } = row as IndexedRow;
    const index = (row as Record<string, unknown>)[indexKey];
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

function dashscopeDecode(payload: unknown, expectedRows: number): number[][] {
  const response = payload as { status_code?: unknown };
  const statusCode = response?.status_code ?? 200;
  if (statusCode !== 200) {
    throw new EmbeddingProviderContractError(
      'Embedding provider rejected the request'
    );
  }
  return extractRows(
    payload,
    expectedRows,
    value => (value.output as { embeddings?: unknown } | undefined)?.embeddings,
    'text_index'
  );
}

function nvidiaDecode(payload: unknown, expectedRows: number): number[][] {
  return extractRows(
    payload,
    expectedRows,
    value => (value as { data?: unknown }).data,
    'index'
  );
}

interface Wire {
  body: (texts: string[], role: EmbeddingRole) => Record<string, unknown>;
  decode: (payload: unknown, expectedRows: number) => number[][];
}

function wireFor(profile: SkillRetrievalProfile): Wire {
  switch (profile.provider_protocol) {
    case 'dashscope-qwen37-native-v1':
      return {
        body: (texts, role) => dashscopeBody(profile, texts, role),
        decode: dashscopeDecode,
      };
    case 'nvidia-query-passage-v1':
      return {
        body: (texts, role) => nvidiaBody(profile, texts, role),
        decode: nvidiaDecode,
      };
  }
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
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  decode: (payload: unknown, expectedRows: number) => number[][],
  expectedRows: number
): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
  return decode(payload, expectedRows);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createProvider(
  profile: SkillRetrievalProfile,
  endpoint: string,
  token: string
): EmbeddingProvider {
  const wire = wireFor(profile);
  return {
    async embed(texts: string[], role: EmbeddingRole): Promise<number[][]> {
      assertTexts(texts);
      let vectors: number[][] | null = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          vectors = await requestOnce(
            endpoint,
            token,
            wire.body(texts, role),
            wire.decode,
            texts.length
          );
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

export function createDashScopeEmbeddingProvider(
  profile: SkillRetrievalProfile,
  options: EmbeddingProviderOptions = {}
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
  return createProvider(profile, endpoint, token);
}

export function createNvidiaEmbeddingProvider(
  profile: SkillRetrievalProfile,
  options: EmbeddingProviderOptions = {}
): EmbeddingProvider {
  const token = (options.token ?? process.env.NVIDIA_API_KEY ?? '').trim();
  const endpoint = (
    options.endpoint ??
    process.env.NVIDIA_ENDPOINT ??
    profile.endpoint
  ).trim();
  if (!token || !endpoint) {
    throw new EmbeddingProviderContractError(
      'Protected NVIDIA API key or endpoint is not configured'
    );
  }
  return createProvider(profile, endpoint, token);
}

// Selects the wire protocol from the locked profile, so switching a published
// profile is a lock change rather than a code change.
export function createEmbeddingProvider(
  profile: SkillRetrievalProfile,
  options: EmbeddingProviderOptions = {}
): EmbeddingProvider {
  switch (profile.provider_protocol) {
    case 'dashscope-qwen37-native-v1':
      return createDashScopeEmbeddingProvider(profile, options);
    case 'nvidia-query-passage-v1':
      return createNvidiaEmbeddingProvider(profile, options);
  }
}
