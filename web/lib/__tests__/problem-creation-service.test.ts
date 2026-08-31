import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

const mocks = vi.hoisted(() => ({
  extractProblemFromImages: vi.fn(),
  checkContentLimit: vi.fn(),
  deriveProblemImageAssets: vi.fn(),
  ensurePresetSubjects: vi.fn(),
  revalidateProblemComprehensive: vi.fn(),
  convertMathTextToTipTapHtml: vi.fn((value: string) => value),
}));

vi.mock('@/lib/problem-extraction-service', () => ({
  extractProblemFromImages: mocks.extractProblemFromImages,
}));
vi.mock('@/lib/content-limits', () => ({
  checkContentLimit: mocks.checkContentLimit,
}));
vi.mock('@/lib/problem-image-service', () => ({
  deriveProblemImageAssets: mocks.deriveProblemImageAssets,
}));
vi.mock('@/lib/subject-presets', () => ({
  DEFAULT_PRESET_SUBJECT_NAME: '未分类',
  ensurePresetSubjects: mocks.ensurePresetSubjects,
}));
vi.mock('@/lib/cache-invalidation', () => ({
  revalidateProblemComprehensive: mocks.revalidateProblemComprehensive,
}));
vi.mock('@/lib/math-to-tiptap', () => ({
  convertMathTextToTipTapHtml: mocks.convertMathTextToTipTapHtml,
}));

import {
  createProblem,
  createProblemFromImages,
} from '@/lib/problem-creation-service';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_SUBJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IMAGE = { data: 'eA==', mime_type: 'image/png' as const };

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    extraction: {
      title: 'Visible Choice',
      content: '',
      parts: [
        {
          index: 1,
          label: null,
          type: 'single_choice',
          content: 'Choose one.',
          full_marks: 2,
          mcq_choices: [
            { id: 'A', text: '$1$' },
            { id: 'B', text: '$2$' },
          ],
          answer_hint: null,
        },
      ],
      suggest_image_asset: false,
      new_tag_names: ['motion'],
      confidence: {
        problem_type_confidence: 'high',
        content_quality: 'clear',
        has_math: true,
        warnings: [],
      },
      ...overrides,
    },
    suggested_tags: {
      existing: [],
      new: [{ name: 'motion' }],
    },
    ingestion: {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      schema_version: 'wqn.problem-ingestion.v1',
      question_id: 'question-1',
      source_region_ids: ['region-1'],
      visual_region_ids: [],
    },
    quota: { allowed: true, current: 1, limit: 10, remaining: 9 },
  };
}

function structuredProblem(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Visible Choice',
    content: '',
    parts: [
      {
        index: 1,
        label: null,
        type: 'single_choice' as const,
        content: 'Choose one.',
        full_marks: 2,
        mcq_choices: [
          { id: 'A', text: '$1$' },
          { id: 'B', text: '$2$' },
        ],
        answer_hint: null,
      },
    ],
    suggest_image_asset: false,
    suggested_tags: { new_tag_names: ['motion'] },
    confidence: {
      problem_type_confidence: 'high' as const,
      content_quality: 'clear' as const,
      has_math: true,
      warnings: [],
    },
    ...overrides,
  };
}

interface FakeState {
  problem: any | null;
  subjectId: string;
  setSubjectId: string;
  tagLinks: Set<string>;
  setLinked: boolean;
  reviewCreated: boolean;
  failReviewOnce: boolean;
  uploads: string[];
  removed: string[];
}

function makeSupabase(
  options: Partial<
    Pick<FakeState, 'subjectId' | 'setSubjectId' | 'failReviewOnce'>
  > = {}
) {
  const state: FakeState = {
    problem: null,
    subjectId: options.subjectId ?? SUBJECT_ID,
    setSubjectId: options.setSubjectId ?? SUBJECT_ID,
    tagLinks: new Set(),
    setLinked: false,
    reviewCreated: false,
    failReviewOnce: options.failReviewOnce ?? false,
    uploads: [],
    removed: [],
  };
  const tag = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'motion' };

  class Builder {
    private operation: 'select' | 'insert' | 'upsert' = 'select';
    private payload: any;
    private filters = new Map<string, unknown>();

    constructor(private readonly table: string) {}

    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.set(column, value);
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    insert(payload: any) {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }
    upsert(payload: any) {
      this.operation = 'upsert';
      this.payload = payload;
      return this;
    }

    async maybeSingle() {
      if (this.table === 'problems') {
        return { data: state.problem, error: null };
      }
      if (this.table === 'subjects') {
        return { data: { id: state.subjectId }, error: null };
      }
      if (this.table === 'problem_sets') {
        return {
          data: { id: SET_ID, subject_id: state.setSubjectId },
          error: null,
        };
      }
      if (this.table === 'problem_set_problems') {
        return {
          data: state.setLinked ? { id: 'link-id' } : null,
          error: null,
        };
      }
      return { data: null, error: null };
    }

    async single() {
      if (this.table === 'tags') return { data: tag, error: null };
      if (this.table === 'problems' && this.operation === 'insert') {
        const now = '2026-08-02T00:00:00.000Z';
        state.problem = {
          ...this.payload,
          created_at: now,
        };
        return {
          data: {
            id: this.payload.id,
            subject_id: this.payload.subject_id,
            title: this.payload.title,
            content: this.payload.content,
            parts: this.payload.parts,
            status: this.payload.status,
            assets: this.payload.assets,
            created_at: now,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }

    private async result() {
      if (this.table === 'problem_tag') {
        if (this.operation === 'upsert') {
          for (const row of this.payload) state.tagLinks.add(row.tag_id);
          return { data: null, error: null };
        }
        return {
          data: [...state.tagLinks].map(tagId => ({
            tags: { ...tag, id: tagId },
          })),
          error: null,
        };
      }
      if (this.table === 'problem_set_problems') {
        if (this.operation === 'insert') state.setLinked = true;
        return {
          data:
            this.operation === 'select' && state.setLinked
              ? [{ problem_set_id: SET_ID }]
              : null,
          error: null,
        };
      }
      if (this.table === 'review_schedule') {
        if (state.failReviewOnce) {
          state.failReviewOnce = false;
          return { data: null, error: { message: 'temporary review failure' } };
        }
        state.reviewCreated = true;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    then(
      resolve: (value: unknown) => unknown,
      reject: (error: unknown) => unknown
    ) {
      return this.result().then(resolve, reject);
    }
  }

  const storage = {
    from: vi.fn(() => ({
      upload: vi.fn(async (path: string) => {
        state.uploads.push(path);
        return { error: null };
      }),
      remove: vi.fn(async (paths: string[]) => {
        state.removed.push(...paths);
        return { error: null };
      }),
    })),
  };
  return {
    supabase: {
      from: vi.fn((table: string) => new Builder(table)),
      storage,
    } as any,
    state,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkContentLimit.mockResolvedValue({
    allowed: true,
    current: 0,
    limit: 100,
    remaining: 100,
  });
  mocks.extractProblemFromImages.mockResolvedValue(extraction());
  mocks.deriveProblemImageAssets.mockImplementation(async assets => assets);
  mocks.ensurePresetSubjects.mockResolvedValue(undefined);
  mocks.revalidateProblemComprehensive.mockResolvedValue(undefined);
});

describe('createProblemFromImages', () => {
  it('creates a complete problem and replays the same request deterministically', async () => {
    const { supabase, state } = makeSupabase();
    const input = {
      request_id: 'create_problem_0001',
      images: [IMAGE],
      subject_id: SUBJECT_ID,
      problem_set_id: SET_ID,
    };
    const first = await createProblemFromImages(supabase, USER_ID, input);
    const second = await createProblemFromImages(supabase, USER_ID, input);

    expect(second.problem.id).toBe(first.problem.id);
    expect(second.replayed).toBe(true);
    expect(mocks.extractProblemFromImages).toHaveBeenCalledTimes(1);
    expect(state.tagLinks.size).toBe(1);
    expect(state.setLinked).toBe(true);
    expect(state.reviewCreated).toBe(true);
    const legacyImageHash = createHash('sha256')
      .update(IMAGE.mime_type)
      .update('\0')
      .update(IMAGE.data)
      .digest('hex');
    const legacyFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          subject_id: SUBJECT_ID,
          problem_set_id: SET_ID,
          save_source_images: null,
          images: [legacyImageHash],
        })
      )
      .digest('hex');
    expect(state.problem.source.mcp_request_fingerprint).toBe(
      legacyFingerprint
    );
    expect(state.problem.source).toMatchObject({
      ingestion_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      ingestion_schema_version: 'wqn.problem-ingestion.v1',
      ingestion_question_id: 'question-1',
      source_region_ids: ['region-1'],
    });
  });

  it('resumes incomplete relation writes before returning a replay', async () => {
    const { supabase, state } = makeSupabase({ failReviewOnce: true });
    const input = {
      request_id: 'create_problem_0002',
      images: [IMAGE],
      subject_id: SUBJECT_ID,
    };
    await expect(
      createProblemFromImages(supabase, USER_ID, input)
    ).rejects.toMatchObject({ code: 'review_schedule_create_failed' });
    expect(state.problem).not.toBeNull();
    expect(state.reviewCreated).toBe(false);

    const replay = await createProblemFromImages(supabase, USER_ID, input);
    expect(replay.replayed).toBe(true);
    expect(state.reviewCreated).toBe(true);
    expect(mocks.extractProblemFromImages).toHaveBeenCalledTimes(1);
  });

  it('rejects request_id reuse with different image input', async () => {
    const { supabase } = makeSupabase();
    const base = {
      request_id: 'create_problem_0003',
      images: [IMAGE],
      subject_id: SUBJECT_ID,
    };
    await createProblemFromImages(supabase, USER_ID, base);
    await expect(
      createProblemFromImages(supabase, USER_ID, {
        ...base,
        images: [{ ...IMAGE, data: 'eQ==' }],
      })
    ).rejects.toMatchObject({ code: 'request_id_reused', status: 409 });
    expect(mocks.extractProblemFromImages).toHaveBeenCalledTimes(1);
  });

  it('uses the uncategorized subject when subject is omitted', async () => {
    const { supabase, state } = makeSupabase();
    const result = await createProblemFromImages(supabase, USER_ID, {
      request_id: 'create_problem_0004',
      images: [IMAGE],
    });
    expect(mocks.ensurePresetSubjects).toHaveBeenCalledWith(supabase, USER_ID);
    expect(result.problem.subject_id).toBe(state.subjectId);
  });

  it('rejects a problem set from another subject', async () => {
    const { supabase } = makeSupabase({ setSubjectId: OTHER_SUBJECT_ID });
    await expect(
      createProblemFromImages(supabase, USER_ID, {
        request_id: 'create_problem_0005',
        images: [IMAGE],
        subject_id: SUBJECT_ID,
        problem_set_id: SET_ID,
      })
    ).rejects.toMatchObject({ code: 'subject_mismatch', status: 409 });
    expect(mocks.extractProblemFromImages).not.toHaveBeenCalled();
  });

  it('does not allow essential visual content to be discarded', async () => {
    mocks.extractProblemFromImages.mockResolvedValue(
      extraction({ suggest_image_asset: true })
    );
    const { supabase, state } = makeSupabase();
    await expect(
      createProblemFromImages(supabase, USER_ID, {
        request_id: 'create_problem_0006',
        images: [IMAGE],
        subject_id: SUBJECT_ID,
        save_source_images: false,
      })
    ).rejects.toMatchObject({ code: 'image_asset_required', status: 422 });
    expect(state.uploads).toEqual([]);
    expect(state.problem).toBeNull();
  });

  it('saves source images by default when visual content is essential', async () => {
    mocks.extractProblemFromImages.mockResolvedValue(
      extraction({ suggest_image_asset: true })
    );
    const { supabase, state } = makeSupabase();
    const result = await createProblemFromImages(supabase, USER_ID, {
      request_id: 'create_problem_0008',
      images: [IMAGE],
      subject_id: SUBJECT_ID,
    });
    expect(state.uploads).toHaveLength(1);
    expect(result.problem.assets).toEqual([
      expect.objectContaining({ path: state.uploads[0], kind: 'image' }),
    ]);
  });

  it('keeps the problem and reports skipped tags at the subject tag limit', async () => {
    mocks.checkContentLimit
      .mockResolvedValueOnce({
        allowed: true,
        current: 0,
        limit: 100,
        remaining: 100,
      })
      .mockResolvedValueOnce({
        allowed: false,
        current: 50,
        limit: 50,
        remaining: 0,
      });
    const { supabase, state } = makeSupabase();
    const result = await createProblemFromImages(supabase, USER_ID, {
      request_id: 'create_problem_0009',
      images: [IMAGE],
      subject_id: SUBJECT_ID,
    });
    expect(result.problem.id).toBeTruthy();
    expect(result.problem.tags).toEqual([]);
    expect(result.extraction.warnings).toEqual([
      expect.stringContaining('tag limit'),
    ]);
    expect(state.tagLinks.size).toBe(0);
  });

  it('preserves choices in the statement when no visible answer exists', async () => {
    const { supabase } = makeSupabase();
    const result = await createProblemFromImages(supabase, USER_ID, {
      request_id: 'create_problem_0007',
      images: [IMAGE],
      subject_id: SUBJECT_ID,
    });
    expect(result.problem.content).toContain('A. $1$');
    expect(result.problem.content).toContain('B. $2$');
    expect((result.problem.parts as any)[0]).not.toHaveProperty(
      'answer_config'
    );
  });
});

describe('createProblem', () => {
  it('saves a structured problem without model inference, quota, or image assets', async () => {
    const { supabase, state } = makeSupabase();
    const input = {
      request_id: 'create_structured_problem_0001',
      ...structuredProblem(),
      subject_id: SUBJECT_ID,
      problem_set_id: SET_ID,
    };
    const first = await createProblem(supabase, USER_ID, input);
    const replay = await createProblem(supabase, USER_ID, input);

    expect(first.problem.assets).toEqual([]);
    expect(first.quota).toBeNull();
    expect(state.uploads).toEqual([]);
    expect(state.problem.source).toMatchObject({
      actor: 'mcp',
      mcp_source_kind: 'structured',
    });
    expect(state.tagLinks.size).toBe(1);
    expect(state.setLinked).toBe(true);
    expect(state.reviewCreated).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(mocks.extractProblemFromImages).not.toHaveBeenCalled();
  });

  it('normalizes part order and discards low-confidence answer hints', async () => {
    const { supabase, state } = makeSupabase();
    const result = await createProblem(supabase, USER_ID, {
      request_id: 'create_structured_problem_0002',
      ...structuredProblem({
        parts: [
          {
            index: 9,
            label: '(2)',
            type: 'fill_blank',
            content: 'Second part.',
            answer_hint: {
              short_answer_value: '42',
              short_answer_is_numeric: true,
              answer_confidence: 'high',
            },
          },
          {
            index: 3,
            label: '(1)',
            type: 'short_answer',
            content: 'First part.',
            answer_hint: {
              short_answer_value: 'uncertain',
              short_answer_is_numeric: false,
              answer_confidence: 'low',
            },
          },
        ],
      }),
      subject_id: SUBJECT_ID,
    });

    expect(state.problem.parts).toEqual([
      expect.objectContaining({ index: 1, label: '(1)' }),
      expect.objectContaining({
        index: 2,
        label: '(2)',
        correct_answer: '42',
      }),
    ]);
    expect(state.problem.parts[0]).not.toHaveProperty('correct_answer');
    expect(result.problem.content.indexOf('First part.')).toBeLessThan(
      result.problem.content.indexOf('Second part.')
    );
  });

  it('rejects structured input that depends on missing visual content', async () => {
    const { supabase, state } = makeSupabase();
    await expect(
      createProblem(supabase, USER_ID, {
        request_id: 'create_structured_problem_0003',
        ...structuredProblem({ suggest_image_asset: true }),
        subject_id: SUBJECT_ID,
      })
    ).rejects.toMatchObject({
      code: 'image_asset_required',
      status: 422,
    });
    expect(state.problem).toBeNull();
    expect(mocks.extractProblemFromImages).not.toHaveBeenCalled();
  });

  it('rejects a blank normalized title before persistence', async () => {
    const { supabase, state } = makeSupabase();
    await expect(
      createProblem(supabase, USER_ID, {
        request_id: 'create_structured_problem_blank_title',
        ...structuredProblem({ title: '   ' }),
        subject_id: SUBJECT_ID,
      })
    ).rejects.toMatchObject({
      code: 'invalid_problem_structure',
      status: 400,
    });
    expect(state.problem).toBeNull();
  });

  it('rejects changed structured input under the same request_id', async () => {
    const { supabase } = makeSupabase();
    const requestId = 'create_structured_problem_0004';
    await createProblem(supabase, USER_ID, {
      request_id: requestId,
      ...structuredProblem(),
      subject_id: SUBJECT_ID,
    });
    await expect(
      createProblem(supabase, USER_ID, {
        request_id: requestId,
        ...structuredProblem({ title: 'Different title' }),
        subject_id: SUBJECT_ID,
      })
    ).rejects.toMatchObject({ code: 'request_id_reused', status: 409 });
  });

  it('does not allow one request_id to switch between image and structured sources', async () => {
    const { supabase } = makeSupabase();
    const requestId = 'create_problem_cross_source_0001';
    await createProblemFromImages(supabase, USER_ID, {
      request_id: requestId,
      images: [IMAGE],
      subject_id: SUBJECT_ID,
    });
    await expect(
      createProblem(supabase, USER_ID, {
        request_id: requestId,
        ...structuredProblem(),
        subject_id: SUBJECT_ID,
      })
    ).rejects.toMatchObject({ code: 'request_id_reused', status: 409 });
  });

  it('uses the uncategorized subject when subject is omitted', async () => {
    const { supabase, state } = makeSupabase();
    const result = await createProblem(supabase, USER_ID, {
      request_id: 'create_structured_problem_0005',
      ...structuredProblem(),
    });
    expect(mocks.ensurePresetSubjects).toHaveBeenCalledWith(supabase, USER_ID);
    expect(result.problem.subject_id).toBe(state.subjectId);
  });
});
