/** Preserve input order, bound active work, and settle started work on failure. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('Concurrency must be a positive safe integer');
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await map(items[index], index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  if (failed) throw failure;
  return results;
}
