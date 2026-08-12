import { describe, expect, it, vi } from 'vitest';
import {
  createDashScopeEmbeddingProvider,
  EmbeddingProviderContractError,
  EmbeddingProviderTransientError,
} from '@/lib/problem-marks/retrieval/embedding-provider';
import type { SkillRetrievalProfile } from '@/lib/problem-marks/retrieval/skill-artifact';

function profile(): SkillRetrievalProfile {
  return {
    profile_id: 'skill-rag-qwen37-v1',
    provider_protocol: 'dashscope-qwen37-native-v1',
    provider: 'dashscope',
    endpoint: 'https://dashscope.test/embedding',
    model: 'qwen3.7-text-embedding',
    model_identity_policy: 'hosted_alias',
    model_identity: 'qwen3.7-text-embedding',
    dimension: 2,
    encoding_format: 'float',
    normalization: 'l2',
    document_contract: { text_type: 'document', output_type: 'dense' },
    query_contract: {
      text_type: 'query',
      output_type: 'dense',
      instruct: 'Retrieve the relevant skill.',
    },
    document_template_version: 'doc-v1',
    query_template_version: 'query-v1',
    tokenizer: null,
  } as unknown as SkillRetrievalProfile;
}

describe('DashScope native embedding provider', () => {
  it('sends query-only instruction and client-normalizes vectors', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status_code: 200,
        output: { embeddings: [{ text_index: 0, embedding: [3, 4] }] },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = createDashScopeEmbeddingProvider(profile(), {
        endpoint: 'https://dashscope.test/embedding',
        token: 'secret',
      });
      await expect(provider.embed(['题面'], 'query')).resolves.toEqual([
        [0.6, 0.8],
      ]);
      const request = JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string
      );
      expect(request).toEqual({
        model: 'qwen3.7-text-embedding',
        input: { texts: ['题面'] },
        parameters: {
          dimension: 2,
          output_type: 'dense',
          text_type: 'query',
          instruct: 'Retrieve the relevant skill.',
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses document text_type without query instruction', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status_code: 200,
        output: { embeddings: [{ text_index: 0, embedding: [0, 1] }] },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = createDashScopeEmbeddingProvider(profile(), {
        endpoint: 'https://dashscope.test/embedding',
        token: 'secret',
      });
      await provider.embed(['document'], 'document');
      const request = JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string
      );
      expect(request.parameters).toEqual({
        dimension: 2,
        output_type: 'dense',
        text_type: 'document',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed for malformed rows and non-2xx contract responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          status_code: 200,
          output: { embeddings: [{ text_index: 0, embedding: [0, 1, 0] }] },
        })
      )
    );
    const provider = createDashScopeEmbeddingProvider(profile(), {
      endpoint: 'https://dashscope.test/embedding',
      token: 'secret',
    });
    await expect(provider.embed(['题面'], 'query')).rejects.toBeInstanceOf(
      EmbeddingProviderContractError
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    );
    await expect(provider.embed(['题面'], 'query')).rejects.toBeInstanceOf(
      EmbeddingProviderContractError
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 }))
    );
    await expect(provider.embed(['题面'], 'query')).rejects.toBeInstanceOf(
      EmbeddingProviderTransientError
    );
    vi.unstubAllGlobals();
  });
});
