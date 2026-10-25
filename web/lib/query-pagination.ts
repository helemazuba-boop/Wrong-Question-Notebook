/** A database page. The server may cap it below the requested size. */
export interface QueryPage<T, E> {
  data: T[] | null;
  error: E | null;
}

/**
 * Read a complete, stably ordered query using bounded requests. Advance by the
 * number actually returned and require an empty page: a short response can be
 * the server's row cap rather than the end of the result set.
 *
 * The projection must include its unique ordering key. The caller owns
 * authorization and ordering. This is not a transactional
 * snapshot; immutable manifests must still validate their snapshot/revision.
 */
export async function readAllQueryPages<T, E>(
  fetchPage: (offset: number, limit: number) => PromiseLike<QueryPage<T, E>>,
  pageSize = 500
): Promise<QueryPage<T, E>> {
  return readQueryWindow(fetchPage, 0, Infinity, pageSize);
}

/** Read a bounded window even when the server returns smaller pages. */
export async function readQueryWindow<T, E>(
  fetchPage: (offset: number, limit: number) => PromiseLike<QueryPage<T, E>>,
  start: number,
  length: number,
  pageSize = 500
): Promise<QueryPage<T, E>> {
  const rows: T[] = [];
  let offset = start;
  const seen = new Set<string | undefined>();
  while (rows.length < length) {
    const { data, error } = await fetchPage(
      offset,
      Math.min(pageSize, length - rows.length)
    );
    // Never return a successful partial collection after a failed later page.
    if (error) return { data: null, error };
    const page = data ?? [];
    if (page.length === 0) return { data: rows, error: null };
    for (const row of page) {
      const key = JSON.stringify(
        typeof row === 'object' && row !== null && 'id' in row ? row.id : row
      );
      if (seen.has(key)) {
        throw new Error(
          'Paginated query did not advance or changed; retry the collection'
        );
      }
      seen.add(key);
    }
    rows.push(...page);
    offset += page.length;
  }
  return { data: rows, error: null };
}
