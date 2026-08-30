import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateContent: vi.fn(),
  checkAndIncrementQuota: vi.fn(),
  refundQuotaUsage: vi.fn(),
  acquireExternalProviderRateLimit: vi.fn(),
  getUserTimezone: vi.fn(),
}));

vi.mock('@/lib/ai/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ai/client')>()),
  createAIClient: () => ({ generateContent: mocks.generateContent }),
}));
vi.mock('@/lib/usage-quota', () => ({
  checkAndIncrementQuota: mocks.checkAndIncrementQuota,
  refundQuotaUsage: mocks.refundQuotaUsage,
}));
vi.mock('@/lib/external-provider-rate-limit', () => ({
  acquireExternalProviderRateLimit: mocks.acquireExternalProviderRateLimit,
}));
vi.mock('@/lib/timezone-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/timezone-utils')>()),
  getUserTimezone: mocks.getUserTimezone,
}));

import {
  extractProblemFromImages,
  PROBLEM_EXTRACTION_JSON_SCHEMA,
  PROBLEM_EXTRACTION_SYSTEM_PROMPT,
} from '@/lib/problem-extraction-service';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAMUlEQVRIie3QMQ0AAAjAMPybBgm7+FoDSzb7bASKRcmiZFGyKFmULEoWJYuSRel90QGLVfSmL9cHVAAAAABJRU5ErkJggg==',
  mime_type: 'image/png' as const,
};
const VALID_EXTRACTION = {
  title: 'Linear Motion',
  content: '',
  parts: [
    {
      index: 1,
      label: null,
      type: 'single_choice',
      content: 'Choose the correct velocity.',
      full_marks: 2,
      mcq_choices: [
        { id: 'A', text: '$1$' },
        { id: 'B', text: '$2$' },
      ],
      answer_hint: {
        mcq_correct_choice_id: 'B',
        short_answer_value: null,
        short_answer_is_numeric: null,
        extended_working: null,
        answer_confidence: 'high',
      },
    },
  ],
  suggest_image_asset: false,
  suggested_tags: { new_tag_names: ['Kinematics', 'New Concept'] },
  confidence: {
    problem_type_confidence: 'high',
    content_quality: 'clear',
    has_math: true,
    warnings: [],
  },
};

function supabaseWithTags(tags: Array<{ id: string; name: string }> = []) {
  const builder: any = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: tags, error: null }).then(resolve);
  return { from: vi.fn(() => builder) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserTimezone.mockResolvedValue('Asia/Shanghai');
  mocks.checkAndIncrementQuota.mockResolvedValue({
    allowed: true,
    current: 1,
    limit: 10,
    remaining: 9,
  });
  mocks.refundQuotaUsage.mockResolvedValue(0);
  mocks.acquireExternalProviderRateLimit.mockResolvedValue({
    allowed: true,
    current_count: 1,
    limit: 10,
    retry_after_ms: 100,
  });
  mocks.generateContent.mockResolvedValue({
    text: JSON.stringify(VALID_EXTRACTION),
  });
});

describe('problem extraction service', () => {
  it('keeps the shared prompt faithful to the extraction contract', () => {
    expect(PROBLEM_EXTRACTION_SYSTEM_PROMPT).toContain(
      'Extract faithfully. Do NOT solve the problem.'
    );
    expect(PROBLEM_EXTRACTION_SYSTEM_PROMPT).toContain('A problem is a SHELL');
    expect(PROBLEM_EXTRACTION_SYSTEM_PROMPT).toContain(
      'Only extract answers VISUALLY PRESENT'
    );
    expect(PROBLEM_EXTRACTION_SYSTEM_PROMPT).toContain(
      'every backslash in KaTeX must be escaped'
    );
    expect(PROBLEM_EXTRACTION_JSON_SCHEMA.required).toEqual([
      'title',
      'content',
      'parts',
      'suggest_image_asset',
      'suggested_tags',
      'confidence',
    ]);
    expect(PROBLEM_EXTRACTION_JSON_SCHEMA.properties.parts).toMatchObject({
      minItems: 1,
      maxItems: 10,
    });
  });

  it('rejects invalid image counts and decoded size before spending quota', async () => {
    const supabase = supabaseWithTags();
    await expect(
      extractProblemFromImages(supabase, USER_ID, [], SUBJECT_ID)
    ).rejects.toMatchObject({ code: 'invalid_images' });
    await expect(
      extractProblemFromImages(
        supabase,
        USER_ID,
        Array.from({ length: 5 }, () => IMAGE),
        SUBJECT_ID
      )
    ).rejects.toMatchObject({ code: 'invalid_images' });
    await expect(
      extractProblemFromImages(
        supabase,
        USER_ID,
        [{ ...IMAGE, data: 'A'.repeat(7_000_000) }],
        SUBJECT_ID
      )
    ).rejects.toMatchObject({ code: 'image_too_large' });
    expect(mocks.checkAndIncrementQuota).not.toHaveBeenCalled();
  });

  it('returns a typed quota error without calling the model', async () => {
    mocks.checkAndIncrementQuota.mockResolvedValue({
      allowed: false,
      current: 10,
      limit: 10,
      remaining: 0,
    });
    await expect(
      extractProblemFromImages(supabaseWithTags(), USER_ID, [IMAGE], SUBJECT_ID)
    ).rejects.toMatchObject({
      code: 'extraction_quota_exhausted',
      status: 429,
      retryable: false,
    });
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.refundQuotaUsage).not.toHaveBeenCalled();
  });

  it('cleans output and separates matching existing tags from new tags', async () => {
    const result = await extractProblemFromImages(
      supabaseWithTags([{ id: 'tag-1', name: 'kinematics' }]),
      USER_ID,
      [IMAGE],
      SUBJECT_ID
    );

    expect(result.extraction.title).toBe('Linear Motion');
    expect(result.extraction.parts[0].answer_hint).toMatchObject({
      mcq_correct_choice_id: 'B',
    });
    expect(result.suggested_tags).toEqual({
      existing: [{ id: 'tag-1', name: 'kinematics' }],
      new: [{ name: 'New Concept' }],
    });
    expect(mocks.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: expect.any(String),
                },
              }),
            ]),
          }),
        ],
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          systemInstruction: expect.stringContaining('kinematics'),
        }),
      })
    );
    expect(mocks.refundQuotaUsage).not.toHaveBeenCalled();
  });

  it('wraps malformed model output as a retryable typed error', async () => {
    mocks.generateContent.mockResolvedValue({ text: '{"parts":[]}' });
    await expect(
      extractProblemFromImages(supabaseWithTags(), USER_ID, [IMAGE], SUBJECT_ID)
    ).rejects.toMatchObject({
      code: 'invalid_extraction',
      status: 503,
      retryable: true,
    });
    expect(mocks.refundQuotaUsage).toHaveBeenCalledWith(
      USER_ID,
      undefined,
      'Asia/Shanghai'
    );
  });

  it('refunds quota when global provider capacity is exhausted', async () => {
    mocks.acquireExternalProviderRateLimit.mockResolvedValue({
      allowed: false,
      current_count: 10,
      limit: 10,
      retry_after_ms: 250,
    });

    await expect(
      extractProblemFromImages(supabaseWithTags(), USER_ID, [IMAGE], SUBJECT_ID)
    ).rejects.toMatchObject({
      code: 'provider_rate_limited',
      status: 429,
      retryable: true,
      details: { retry_after_ms: 250 },
    });
    expect(mocks.generateContent).not.toHaveBeenCalled();
    expect(mocks.refundQuotaUsage).toHaveBeenCalledTimes(1);
  });

  it('does not expose provider error details and refunds quota', async () => {
    mocks.generateContent.mockRejectedValue(
      new Error('upstream secret diagnostic')
    );

    await expect(
      extractProblemFromImages(supabaseWithTags(), USER_ID, [IMAGE], SUBJECT_ID)
    ).rejects.toMatchObject({
      code: 'extraction_failed',
      message: 'AI extraction failed',
      status: 503,
    });
    expect(mocks.refundQuotaUsage).toHaveBeenCalledTimes(1);
  });
});
