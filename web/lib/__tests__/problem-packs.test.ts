import { describe, expect, it, vi } from 'vitest';
import {
  buildProblemPack,
  loadProblemStudyManifest,
} from '@/lib/problem-packs';
import {
  problemPackMetaSchema,
  problemPackRowSchema,
} from '@/lib/problem-study-v1';
import { registerDeviceImageArtifacts } from '@/lib/device-content-artifacts';

vi.mock('@/lib/device-content-artifacts', () => ({
  materializeDevicePackArtifact: vi.fn().mockResolvedValue('artifact.jsonl'),
  registerDeviceImageArtifacts: vi.fn(
    async (_client: unknown, _userId: string, groups: unknown[]) => ({
      registered: groups.flatMap(group =>
        Array.isArray(group)
          ? group.flatMap(value => {
              const asset = value as {
                image_id?: unknown;
                gray4_image_id?: unknown;
              };
              return [asset.image_id, asset.gray4_image_id]
                .filter((id): id is string => typeof id === 'string')
                .map(image_id => ({
                  image_id,
                  pixel_format: 'bw1' as const,
                  storage_path: `${image_id}.wqni`,
                }));
            })
          : []
      ),
      missing: [],
    })
  ),
}));

const USER_ID = '22222222-2222-4222-8222-222222222222';
const SET_ID = '11111111-1111-4111-8111-111111111111';
const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
const IMAGE_ID =
  '9e00e194c412bff778bfd1235b3b2b25a4f7f8b1d3ef1c72fca11d21b36d1e05';
const SOLUTION_ID =
  '1b1f4d9c22cf8d0b6cf6a52ad4a3f2e8809d15b9a7f96ff2f4bf1cf3a2b4c6d8';
const GRAY4_ID =
  '2c00e194c412bff778bfd1235b3b2b25a4f7f8b1d3ef1c72fca11d21b36d1e05';

const SET_ROW = {
  id: SET_ID,
  name: '圆锥曲线专项',
  subject_id: '99999999-9999-4999-8999-999999999999',
  is_smart: false,
  filter_config: null,
  updated_at: '2026-07-28T03:00:00.000Z',
};

const JUNCTION_ROWS = [
  { problem_id: PROBLEM_ID, added_at: '2026-07-28T03:01:00.000Z', id: 1 },
];

const PROBLEM_ROW = {
  id: PROBLEM_ID,
  title: '生物遗传综合题',
  content: '某二倍体植物的花色由两对等位基因控制。',
  parts: [
    {
      index: 1,
      type: 'single_choice',
      label: '选择',
      full_marks: 6,
      content: '该植物花色遗传遵循的规律是？',
      answer_config: { type: 'mcq', correct_choice_id: 'B' },
    },
    {
      index: 2,
      type: 'essay',
      label: '简答',
      full_marks: 10,
      content: '请用遗传图解说明 F1 自交得到 F2 的过程。',
      correct_answer: '',
    },
  ],
  source: { year: 2024, paper: '全国甲卷' },
  status: 'wrong',
  is_optional: false,
  assets: [
    {
      path: 'p/a.png',
      kind: 'image',
      image_id: IMAGE_ID,
      gray4_image_id: GRAY4_ID,
    },
  ],
  solution_assets: [{ path: 'p/s.png', kind: 'image', image_id: SOLUTION_ID }],
  updated_at: '2026-07-28T03:05:00.000Z',
};

function chain(result: any) {
  const q: any = {};
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'range', 'limit']) {
    q[m] = vi.fn(() => q);
  }
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.single = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: any, reject: any) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

// Each from(table) call pops the next prepared result for that table so a
// single client can serve the set lookup, the junction order, and the member
// fetch in sequence.
function makeClient(tables: Record<string, any[]>) {
  const counters: Record<string, number> = {};
  const from = vi.fn((table: string) => {
    const idx = counters[table] ?? 0;
    counters[table] = idx + 1;
    const list = tables[table] || [];
    return chain(
      list[Math.min(idx, list.length - 1)] ?? { data: null, error: null }
    );
  });
  return { supabase: { from } as any };
}

function manualSetClient() {
  return makeClient({
    problem_sets: [{ data: SET_ROW, error: null }],
    problem_set_problems: [{ data: JUNCTION_ROWS, error: null }],
    problems: [{ data: [PROBLEM_ROW], error: null }],
  });
}

describe('buildProblemPack', () => {
  it('builds a deterministic JSONL pack with meta + one row', async () => {
    const { supabase } = manualSetClient();
    const pack = await buildProblemPack(supabase, USER_ID, SET_ID);

    expect(pack.problem_set_id).toBe(SET_ID);
    expect(pack.entry_count).toBe(1);
    expect(pack.pack_revision).toBe(
      Math.floor(Date.parse('2026-07-28T03:05:00.000Z') / 1000)
    );
    expect(pack.byte_size).toBe(Buffer.byteLength(pack.body, 'utf8'));

    const lines = pack.body.split('\n');
    expect(lines).toHaveLength(2);

    const meta = problemPackMetaSchema.safeParse(JSON.parse(lines[0]));
    expect(meta.success).toBe(true);
    expect(meta.success && meta.data.count).toBe(1);

    const row = problemPackRowSchema.safeParse(JSON.parse(lines[1]));
    expect(row.success).toBe(true);
    if (row.success) {
      expect(row.data.problem_id).toBe(PROBLEM_ID);
      expect(row.data.parts).toHaveLength(2);
      expect(row.data.parts[0].answer_text).toBe('B');
      expect(row.data.image_ids).toEqual([IMAGE_ID]);
      expect(row.data.gray4_image_ids).toEqual([GRAY4_ID]);
      expect(row.data.solution_image_ids).toEqual([SOLUTION_ID]);
      expect(row.data.solution_gray4_image_ids).toEqual([null]);
    }
  });

  it('produces a stable sha256 across rebuilds', async () => {
    const first = await buildProblemPack(
      manualSetClient().supabase,
      USER_ID,
      SET_ID
    );
    const second = await buildProblemPack(
      manualSetClient().supabase,
      USER_ID,
      SET_ID
    );
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps text while omitting image slots whose derivatives are missing', async () => {
    vi.mocked(registerDeviceImageArtifacts).mockResolvedValueOnce({
      registered: [
        {
          image_id: IMAGE_ID,
          pixel_format: 'bw1',
          storage_path: `${IMAGE_ID}.wqni`,
        },
      ],
      missing: [
        {
          image_id: GRAY4_ID,
          pixel_format: 'gray4',
          source_path: `${GRAY4_ID}.wqni`,
        },
        {
          image_id: SOLUTION_ID,
          pixel_format: 'bw1',
          source_path: `${SOLUTION_ID}.wqni`,
        },
      ],
    });
    const pack = await buildProblemPack(
      manualSetClient().supabase,
      USER_ID,
      SET_ID,
      { materialize: true }
    );
    const parsed = problemPackRowSchema.parse(
      JSON.parse(pack.body.split('\n')[1])
    );

    expect(parsed.content_text).toContain('二倍体植物');
    expect(parsed.image_ids).toEqual([IMAGE_ID]);
    expect(parsed.gray4_image_ids).toEqual([null]);
    expect(parsed.solution_image_ids).toEqual([]);
    expect(parsed.solution_gray4_image_ids).toEqual([]);
  });

  it('rejects an unknown problem set with 404', async () => {
    const { supabase } = makeClient({
      problem_sets: [{ data: null, error: null }],
    });
    await expect(
      buildProblemPack(supabase, USER_ID, SET_ID)
    ).rejects.toMatchObject({ code: 'problem_set_not_found', status: 404 });
  });
});

describe('loadProblemStudyManifest', () => {
  it('relists sets with a pack summary and offset cursor', async () => {
    const { supabase } = makeClient({
      problem_sets: [
        { data: [{ id: SET_ID, name: SET_ROW.name }], error: null },
        { data: SET_ROW, error: null },
      ],
      problem_set_problems: [{ data: JUNCTION_ROWS, error: null }],
      problems: [{ data: [PROBLEM_ROW], error: null }],
    });
    const manifest = await loadProblemStudyManifest(
      supabase,
      USER_ID,
      'https://example.com',
      0,
      50
    );
    expect(manifest.cursor).toBe('1');
    expect(manifest.has_more).toBe(false);
    expect(manifest.snapshot_id).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.revision).toBeGreaterThanOrEqual(0);
    expect(manifest.problem_sets).toHaveLength(1);
    const entry = manifest.problem_sets[0];
    expect(entry.problem_set_id).toBe(SET_ID);
    expect(entry.is_smart).toBe(false);
    expect(entry.pack).toMatchObject({
      pack_id: SET_ID,
      schema_version: 1,
      format: 'jsonl',
      compression: 'zlib',
      entry_count: 1,
      download_url: expect.stringMatching(
        new RegExp(
          `^https://example\\.com/api/esp32/v3/problems/packs/${SET_ID}/[0-9a-f]{64}$`
        )
      ),
    });
  });
});
