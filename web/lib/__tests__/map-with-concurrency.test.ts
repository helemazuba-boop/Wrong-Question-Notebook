import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from '../map-with-concurrency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('bounded asynchronous mapping', () => {
  it('runs two tasks at most and preserves input order after out-of-order completion', async () => {
    const gates = Array.from({ length: 4 }, () => deferred<string>());
    const started: number[] = [];
    const result = mapWithConcurrency([0, 1, 2, 3], 2, async index => {
      started.push(index);
      return gates[index].promise;
    });
    expect(started).toEqual([0, 1]);
    gates[1].resolve('one');
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[2].resolve('two');
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    gates[3].resolve('three');
    gates[0].resolve('zero');
    await expect(result).resolves.toEqual(['zero', 'one', 'two', 'three']);
  });

  it('does not schedule more work after failure and waits for started work to settle', async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const failure = new Error('database unavailable');
    const result = mapWithConcurrency([0, 1, 2, 3], 2, async index => {
      started.push(index);
      return gates[index].promise;
    });
    const settled = vi.fn();
    void result.then(settled, settled);
    gates[0].reject(failure);
    await gates[0].promise.catch(() => undefined);
    expect(started).toEqual([0, 1]);
    expect(settled).not.toHaveBeenCalled();
    gates[1].resolve('finished upload');
    await expect(result).rejects.toBe(failure);
    expect(started).toEqual([0, 1]);
  });

  it('handles empty scopes and rejects invalid concurrency', async () => {
    const map = vi.fn();
    await expect(mapWithConcurrency([], 2, map)).resolves.toEqual([]);
    expect(map).not.toHaveBeenCalled();
    for (const limit of [0, -1, 1.5, Infinity])
      await expect(mapWithConcurrency([], limit, map)).rejects.toBeInstanceOf(
        RangeError
      );
  });
});
