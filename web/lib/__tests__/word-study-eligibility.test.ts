import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  wordEligibilityDataSchema,
  wordEligibilityRequestSchema,
  readWordEligibility,
} from '../word-study-eligibility';
import { registerLocalWordStudySessionRequestSchema } from '../word-study-longseq-v1';
import {
  localSessionSemanticFingerprint,
  registerLocalWordStudySession,
} from '../word-study-longseq-service';

vi.mock('../word-progress-wake', () => ({
  wakeWordProgressProjection: vi.fn(),
}));
const base = JSON.parse(
  readFileSync(
    resolve(
      'contracts/word-study-v1/fixtures/valid/local-session-request.json'
    ),
    'utf8'
  )
);
const sha = 'a'.repeat(64);

describe('offline ordering and personal eligibility', () => {
  it('keeps the legacy fingerprint while binding shuffle mode and frozen progress', () => {
    const legacy = registerLocalWordStudySessionRequestSchema.parse(base);
    const shuffle = {
      ...base,
      mode: 'shuffle',
      progress_revision: 41,
      scope: { ...base.scope, include_mastered: false },
    };
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse(shuffle).success
    ).toBe(true);
    expect(localSessionSemanticFingerprint(legacy)).toBe(
      localSessionSemanticFingerprint(base)
    );
    expect(localSessionSemanticFingerprint(shuffle)).not.toBe(
      localSessionSemanticFingerprint(base)
    );
    expect(
      localSessionSemanticFingerprint({ ...shuffle, progress_revision: 42 })
    ).not.toBe(localSessionSemanticFingerprint(shuffle));
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse({
        ...shuffle,
        scope: base.scope,
      }).success
    ).toBe(false);
    expect(
      registerLocalWordStudySessionRequestSchema.safeParse({
        ...shuffle,
        mode: 'review',
      }).success
    ).toBe(false);
  });

  it('routes only explicit new semantics to v2 while preserving v1 retries', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        session_id: base.session_id,
        registered: true,
        replayed: false,
      },
      error: null,
    });
    await registerLocalWordStudySession(
      { rpc } as never,
      'owner',
      'device',
      base
    );
    expect(rpc.mock.calls[0][0]).toBe('register_local_word_study_session_v1');
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_mode');
    const shuffle = {
      ...base,
      mode: 'shuffle',
      progress_revision: 41,
      scope: { ...base.scope, include_mastered: false },
    };
    await registerLocalWordStudySession(
      { rpc } as never,
      'owner',
      'device',
      shuffle
    );
    expect(rpc.mock.calls[1][0]).toBe('register_local_word_study_session_v2');
    expect(rpc.mock.calls[1][1]).toMatchObject({
      p_mode: 'shuffle',
      p_progress_revision: 41,
      p_user_id: 'owner',
      p_device_id: 'device',
    });
  });

  it('accepts complete bounded bitmaps and rejects malformed snapshots', () => {
    expect(
      wordEligibilityDataSchema.safeParse({
        progress_revision: 41,
        item_ids_sha256: sha,
        mastered_bitmap: '00101',
      }).success
    ).toBe(true);
    for (const bits of ['', '010x', '0'.repeat(10001)])
      expect(
        wordEligibilityDataSchema.safeParse({
          progress_revision: 41,
          item_ids_sha256: sha,
          mastered_bitmap: bits,
        }).success
      ).toBe(false);
    const request = { ...base };
    delete request.session_id;
    delete request.scope;
    delete request.seed;
    delete request.start_index;
    delete request.items;
    expect(wordEligibilityRequestSchema.safeParse(request).success).toBe(true);
    expect(
      wordEligibilityRequestSchema.safeParse({
        ...request,
        snapshot: [base.snapshot[0], base.snapshot[0]],
      }).success
    ).toBe(false);
  });

  it('binds the authenticated actor and validates the complete RPC result', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        progress_revision: 41,
        item_ids_sha256: sha,
        mastered_bitmap: '001',
      },
      error: null,
    });
    await readWordEligibility({ rpc } as never, 'owner', 'device', base);
    expect(rpc).toHaveBeenCalledWith('read_word_study_eligibility_v1', {
      p_user_id: 'owner',
      p_device_id: 'device',
      p_snapshot: base.snapshot,
    });
    rpc.mockResolvedValueOnce({
      data: {
        progress_revision: 41,
        item_ids_sha256: sha,
        mastered_bitmap: '001',
        partial: true,
      },
      error: null,
    });
    await expect(
      readWordEligibility({ rpc } as never, 'owner', 'device', base)
    ).rejects.toThrow();
  });
});
