import { describe, expect, it, vi } from 'vitest';
import {
  createProblemMarkCopyMapping,
  inheritProblemMarksBestEffort,
} from '@/lib/problem-marks/copy';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

describe('Problem Mark Copy inheritance', () => {
  it('pre-allocates a distinct destination UUID with the exact source ID', () => {
    const first = createProblemMarkCopyMapping(SOURCE_ID);
    const second = createProblemMarkCopyMapping(SOURCE_ID);

    expect(first.source_problem_id).toBe(SOURCE_ID);
    expect(first.destination_problem_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(first.destination_problem_id).not.toBe(
      second.destination_problem_id
    );
  });

  it('returns validated inheritance counts from the service-only RPC', async () => {
    const mappings = [
      createProblemMarkCopyMapping(SOURCE_ID),
      createProblemMarkCopyMapping('22222222-2222-4222-8222-222222222222'),
    ];
    const rpc = vi.fn().mockResolvedValue({
      data: { inherited: 1, pending: 1 },
      error: null,
    });

    await expect(
      inheritProblemMarksBestEffort({ rpc } as never, mappings)
    ).resolves.toEqual({ inherited: 1, pending: 1 });
    expect(rpc).toHaveBeenCalledWith('inherit_problem_marks', {
      p_mappings: mappings,
    });
  });

  it('keeps every copied Problem pending when the inheritance RPC fails', async () => {
    const mappings = [
      createProblemMarkCopyMapping(SOURCE_ID),
      createProblemMarkCopyMapping('22222222-2222-4222-8222-222222222222'),
    ];
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(
      inheritProblemMarksBestEffort({ rpc } as never, mappings)
    ).resolves.toEqual({ inherited: 0, pending: 2 });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('fails closed to pending when the RPC returns inconsistent counts', async () => {
    const mappings = [createProblemMarkCopyMapping(SOURCE_ID)];
    const rpc = vi.fn().mockResolvedValue({
      data: { inherited: 1, pending: 1 },
      error: null,
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await expect(
      inheritProblemMarksBestEffort({ rpc } as never, mappings)
    ).resolves.toEqual({ inherited: 0, pending: 1 });
    consoleError.mockRestore();
  });
});
