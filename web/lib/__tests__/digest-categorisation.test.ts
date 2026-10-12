import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  queryResult,
  TEST_USER,
  SUBJECT_ID,
  PROBLEM_ID,
} from '@/lib/test/supabase-query';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  quota: vi.fn(),
  ai: vi.fn(),
  timezone: vi.fn(),
}));
vi.mock('@/lib/supabase-utils', () => ({
  createServiceClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock('@/lib/usage-quota', () => ({ checkAndIncrementQuota: mocks.quota }));
vi.mock('@/lib/ai/client', () => ({
  createAIClient: () => ({ generateContent: mocks.ai }),
}));
vi.mock('@/lib/timezone-utils', () => ({ getUserTimezone: mocks.timezone }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { categoriseUncategorisedAttempts } from '@/lib/digest-generator';

const attempt = {
  attempt_id: 'attempt',
  problem_id: PROBLEM_ID,
  subject_id: SUBJECT_ID,
  submitted_answer: {},
  part_results: [{ index: 1, correct: false }],
  is_correct: false,
  cause: null,
  reflection_notes: null,
  selected_status: 'wrong',
  problem_title: 'Fixture problem',
  problem_content: '',
  problem_parts: [],
  subject_name: 'Math',
};
const categorisation = {
  broad_category: 'knowledge_gap',
  granular_tag: 'formula',
  topic_label: 'Functions',
  confidence: 0.8,
  reasoning: 'Fixture reasoning',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: [attempt], error: null });
  mocks.from.mockReturnValue(queryResult([]));
  mocks.quota.mockResolvedValue({ allowed: true });
  mocks.timezone.mockResolvedValue('Asia/Shanghai');
  mocks.ai.mockResolvedValue({ text: JSON.stringify(categorisation) });
});

describe('digest categorisation backfill', () => {
  it('does not consume quota or call AI for an empty backlog', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await categoriseUncategorisedAttempts(TEST_USER.id, 5)).toBe(0);
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  });
  it('stops before AI when the daily categorisation quota is exhausted', async () => {
    mocks.quota.mockResolvedValue({ allowed: false });
    expect(await categoriseUncategorisedAttempts(TEST_USER.id, 5)).toBe(0);
    expect(mocks.ai).not.toHaveBeenCalled();
  });
  it('charges the categorisation quota and persists the failed part and owner', async () => {
    const write = queryResult(categorisation);
    mocks.from.mockReturnValueOnce(queryResult([])).mockReturnValueOnce(write);
    expect(await categoriseUncategorisedAttempts(TEST_USER.id, 5)).toBe(1);
    expect(mocks.quota).toHaveBeenCalledWith(
      TEST_USER.id,
      'ai_categorisation',
      'Asia/Shanghai'
    );
    expect(write.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: TEST_USER.id,
        problem_id: PROBLEM_ID,
        subject_id: SUBJECT_ID,
        attempt_id: 'attempt',
        part_index: 1,
        topic_label: 'Functions',
        is_user_override: false,
      }),
      { onConflict: 'attempt_id', ignoreDuplicates: true }
    );
  });
  it('does not persist malformed AI output', async () => {
    mocks.ai.mockResolvedValue({ text: 'not JSON' });
    expect(await categoriseUncategorisedAttempts(TEST_USER.id, 5)).toBe(0);
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
  it('contains a failed provider call within the batch instead of aborting the whole job', async () => {
    mocks.rpc.mockResolvedValue({
      data: [attempt, { ...attempt, attempt_id: 'second' }],
      error: null,
    });
    const write = queryResult(categorisation);
    mocks.from.mockReturnValueOnce(queryResult([])).mockReturnValueOnce(write);
    mocks.ai
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ text: JSON.stringify(categorisation) });
    expect(await categoriseUncategorisedAttempts(TEST_USER.id, 5)).toBe(1);
    expect(mocks.ai).toHaveBeenCalledTimes(2);
  });
  it('[AUD-04] does not call AI when the quota backend is unavailable', async () => {
    mocks.quota.mockRejectedValue(new Error('quota backend unavailable'));
    await expect(
      categoriseUncategorisedAttempts(TEST_USER.id, 5)
    ).rejects.toThrow('quota is unavailable');
    expect(mocks.ai).not.toHaveBeenCalled();
  });
});
