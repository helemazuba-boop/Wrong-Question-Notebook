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
  ingestProblemsFromImages,
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
  schema_version: 'wqn.problem-ingestion.v1',
  status: 'complete',
  pages: [
    {
      page_id: 'page-1',
      image_index: 0,
      source_asset_id: null,
      coordinate_space: 'normalized_0_1',
      source_width: null,
      source_height: null,
      provider_width: null,
      provider_height: null,
      rotation_degrees: null,
    },
  ],
  regions: [
    {
      region_id: 'region-1',
      page_id: 'page-1',
      role: 'question',
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      text: 'Choose the correct velocity. A. 1 B. 2',
      confidence: 0.98,
    },
  ],
  questions: [
    {
      question_id: 'question-1',
      number_label: '1',
      title: 'Linear Motion',
      shared_stem: [],
      parts: [
        {
          part_id: 'part-1-1',
          index: 1,
          label: null,
          type: 'single_choice',
          content: [{ kind: 'text', value: 'Choose the correct velocity.' }],
          full_marks: 2,
          choices: [
            {
              id: 'A',
              content: [{ kind: 'math_inline', value: '1' }],
              region_ids: [],
            },
            {
              id: 'B',
              content: [{ kind: 'math_inline', value: '2' }],
              region_ids: [],
            },
          ],
          reference_answer: {
            kind: 'printed_answer',
            choice_ids: ['B'],
            content: [],
            confidence: 0.99,
            region_ids: [],
          },
          region_ids: ['region-1'],
          visual_region_ids: [],
          confidence: 0.98,
          warnings: [],
        },
      ],
      region_ids: ['region-1'],
      visual_region_ids: [],
      student_work: [],
      suggested_tags: ['Kinematics', 'New Concept'],
      confidence: 0.98,
      incomplete: false,
      warnings: [],
    },
  ],
  warnings: [],
};

const SECOND_QUESTION = {
  ...VALID_EXTRACTION.questions[0],
  question_id: 'question-2',
  number_label: '2',
  title: 'Acceleration',
  parts: [
    {
      ...VALID_EXTRACTION.questions[0].parts[0],
      part_id: 'part-2-1',
      type: 'fill_blank',
      choices: [],
      reference_answer: null,
    },
  ],
  suggested_tags: [],
  confidence: 0.9,
  incomplete: false,
  warnings: [],
};

function supabaseWithTags(tags: Array<{ id: string; name: string }> = []) {
  const tagBuilder: any = {};
  for (const method of ['select', 'eq', 'order', 'limit']) {
    tagBuilder[method] = vi.fn(() => tagBuilder);
  }
  tagBuilder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: tags, error: null }).then(resolve);
  const ingestionBuilder: any = {};
  ingestionBuilder.insert = vi.fn(() => ingestionBuilder);
  ingestionBuilder.select = vi.fn(() => ingestionBuilder);
  ingestionBuilder.single = vi.fn(() =>
    Promise.resolve({ data: { id: 'ingestion-1' }, error: null })
  );
  return {
    from: vi.fn((table: string) =>
      table === 'problem_ingestions' ? ingestionBuilder : tagBuilder
    ),
  } as any;
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
      'Extract every independent question'
    );
    expect(PROBLEM_EXTRACTION_SYSTEM_PROMPT).toContain(
      'Student handwriting, answer length, or shown working MUST NOT change'
    );
    expect(PROBLEM_EXTRACTION_SYSTEM_PROMPT).toContain(
      'JSON escaping is transport syntax, not content semantics'
    );
    expect(PROBLEM_EXTRACTION_JSON_SCHEMA.required).toEqual([
      'schema_version',
      'status',
      'pages',
      'regions',
      'questions',
      'warnings',
    ]);
    expect(PROBLEM_EXTRACTION_JSON_SCHEMA.properties.questions).toMatchObject({
      type: 'array',
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

  it('rejects more than 20 independent questions without silently truncating', async () => {
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({
        ...VALID_EXTRACTION,
        questions: Array.from({ length: 21 }, (_, index) => ({
          ...SECOND_QUESTION,
          question_id: `question-${index + 1}`,
          number_label: String(index + 1),
          parts: [
            {
              ...SECOND_QUESTION.parts[0],
              part_id: `part-${index + 1}-1`,
            },
          ],
        })),
      }),
    });

    await expect(
      ingestProblemsFromImages(supabaseWithTags(), USER_ID, [IMAGE], SUBJECT_ID)
    ).rejects.toMatchObject({
      code: 'too_many_problems_detected',
      status: 422,
      details: { count: 21, max: 20 },
    });
    expect(mocks.refundQuotaUsage).toHaveBeenCalledWith(
      USER_ID,
      undefined,
      'Asia/Shanghai'
    );
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
    expect(result.ingestion).toMatchObject({
      id: 'ingestion-1',
      question_id: 'question-1',
      source_region_ids: ['region-1'],
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

  it('returns all page questions but refuses to guess in the single-Problem adapter', async () => {
    mocks.generateContent.mockResolvedValue({
      text: JSON.stringify({
        ...VALID_EXTRACTION,
        questions: [VALID_EXTRACTION.questions[0], SECOND_QUESTION],
      }),
    });
    const ingestion = await ingestProblemsFromImages(
      supabaseWithTags(),
      USER_ID,
      [IMAGE],
      SUBJECT_ID
    );
    expect(
      ingestion.candidates.map(candidate => candidate.question_id)
    ).toEqual(['question-1', 'question-2']);

    await expect(
      extractProblemFromImages(supabaseWithTags(), USER_ID, [IMAGE], SUBJECT_ID)
    ).rejects.toMatchObject({
      code: 'multiple_problems_detected',
      status: 422,
      details: { count: 2 },
    });
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
