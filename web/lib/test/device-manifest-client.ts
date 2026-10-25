import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

/** Deterministic PostgREST/storage boundary for the real manifest and pack
 * modules. It enforces projection, owner filters, ordering and a row ceiling;
 * SQL trigger/function behavior is checked separately in PostgreSQL. */
export function manifestClient() {
  const tables: Record<string, Array<Record<string, any>>> = {
    notebooks: [],
    notebook_notes: [],
    note_change_log: [],
    problem_sets: [],
    problem_set_problems: [],
    problems: [],
    problem_tag: [],
    device_content_revisions: [],
    device_pack_artifacts: [],
    device_pack_summaries: [],
    device_image_artifacts: [],
  };
  const objects = new Map<string, Uint8Array>();
  const calls: Array<{ url: URL; method: string; body: any }> = [];
  let activeNoteReads = 0,
    peakNoteReads = 0;
  let hook: ((url: URL) => void) | undefined;
  let fail: ((url: URL) => string | undefined) | undefined;
  function bump(userId: string, domain = 'note_packs') {
    const existing = tables.device_content_revisions.find(
      row => row.scope_key === userId && row.domain === domain
    );
    if (existing) existing.revision++;
    else
      tables.device_content_revisions.push({
        scope_key: userId,
        domain,
        revision: 1,
      });
  }
  function projection(row: Record<string, any>, select: string) {
    if (select.split(',').includes('*')) return { ...row };
    return Object.fromEntries(
      select
        .split(',')
        .filter(key => !key.includes('('))
        .map(key => [key, row[key]])
    );
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    let body: any = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        /* Binary upload. */
      }
    }
    calls.push({ url, method, body });
    const error = fail?.(url);
    if (error) return Response.json({ message: error }, { status: 500 });
    hook?.(url);
    const objectPrefix = '/storage/v1/object/';
    if (url.pathname.startsWith(objectPrefix)) {
      const key = decodeURIComponent(url.pathname.slice(objectPrefix.length));
      if (key === 'copy') {
        const source = objects.get(body.bucketId + '/' + body.sourceKey);
        if (!source)
          return Response.json(
            { message: 'Source object missing', statusCode: '404' },
            { status: 404 }
          );
        objects.set(body.bucketId + '/' + body.destinationKey, source);
        return Response.json({ Key: body.destinationKey });
      }
      if (method === 'POST') {
        objects.set(
          key,
          new Uint8Array(await new Response(init?.body).arrayBuffer())
        );
        return Response.json({ Key: key });
      }
      const bytes = objects.get(key);
      return bytes
        ? new Response(bytes as BodyInit)
        : Response.json(
            { message: 'Not found', statusCode: '404' },
            { status: 404 }
          );
    }
    const table = url.pathname.split('/').at(-1)!;
    let rows: Array<Record<string, any>>;
    if (table === 'device_note_pack_sources_v1') {
      rows = tables.notebooks
        .filter(
          row => row.user_id === body.p_user_id && row.archived_at == null
        )
        .map(row => {
          const notes = tables.notebook_notes.filter(
            note =>
              note.user_id === body.p_user_id &&
              note.notebook_id === row.id &&
              note.archived_at == null
          );
          const content_revision = Math.max(
            0,
            ...tables.note_change_log
              .filter(
                log =>
                  log.user_id === body.p_user_id && log.notebook_id === row.id
              )
              .map(log => log.change_seq)
          );
          return {
            id: row.id,
            title: row.title,
            content_revision,
            source_key: createHash('sha256')
              .update(
                JSON.stringify([
                  content_revision,
                  notes.map(note => [note.id, note.revision, note.sort_index]),
                  tables.device_content_revisions.find(
                    rev =>
                      rev.scope_key === body.p_user_id + ':device_images' &&
                      rev.domain === 'note_packs'
                  )?.revision ?? 0,
                ])
              )
              .digest('hex'),
          };
        });
    } else {
      if (!tables[table]) throw new Error('Unhandled fixture table ' + table);
      rows = tables[table];
      if (method === 'POST') {
        const values = Array.isArray(body) ? body : [body];
        const conflict = url.searchParams.get('on_conflict')?.split(',') ?? [];
        for (const value of values) {
          const existing = conflict.length
            ? rows.find(row => conflict.every(key => row[key] === value[key]))
            : undefined;
          if (existing) Object.assign(existing, value);
          else rows.push({ ...value });
        }
        return new Response(null, { status: 204 });
      }
    }
    rows = rows.filter(row =>
      [...url.searchParams].every(([key, value]) => {
        if (
          ['select', 'order', 'offset', 'limit', 'on_conflict'].includes(key) ||
          key.startsWith('matching_tags.')
        )
          return true;
        if (key === 'or') {
          const date = /last_reviewed_date.lt.([^,]+)/.exec(value)?.[1];
          return (
            row.last_reviewed_date == null ||
            (date && Date.parse(row.last_reviewed_date) < Date.parse(date))
          );
        }
        if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
        if (value === 'is.null') return row[key] == null;
        if (value.startsWith('lt.'))
          return (
            row[key] != null &&
            Date.parse(row[key]) < Date.parse(value.slice(3))
          );
        if (value.startsWith('in.('))
          return value.slice(4, -1).split(',').includes(String(row[key]));
        throw new Error('Unhandled fixture predicate ' + key + '=' + value);
      })
    );
    const tags = url.searchParams.get('matching_tags.tag_id');
    if (tags) {
      const ids = tags.slice(4, -1).split(',');
      const owner = url.searchParams.get('matching_tags.user_id')!.slice(3);
      rows = rows.filter(row =>
        tables.problem_tag.some(
          link =>
            link.user_id === owner &&
            link.problem_id === row.id &&
            ids.includes(link.tag_id)
        )
      );
    }
    for (const term of (url.searchParams.get('order') ?? '')
      .split(',')
      .reverse()) {
      if (!term) continue;
      const [key, direction] = term.split('.');
      rows = [...rows].sort(
        (a, b) =>
          (typeof a[key] === 'number' && typeof b[key] === 'number'
            ? a[key] - b[key]
            : String(a[key]).localeCompare(String(b[key]))) *
          (direction === 'desc' ? -1 : 1)
      );
    }
    if (method === 'DELETE') {
      const deleted = new Set(rows);
      tables[table] = tables[table].filter(row => !deleted.has(row));
      for (const row of rows) {
        if (table === 'device_pack_artifacts') {
          tables.device_pack_summaries = tables.device_pack_summaries.filter(
            cached =>
              !(
                cached.user_id === row.user_id &&
                cached.domain === row.domain &&
                cached.logical_id === row.logical_id &&
                cached.sha256 === row.sha256
              )
          );
          bump(row.user_id, row.domain);
        } else if (table === 'device_image_artifacts') {
          bump(row.user_id + ':device_images');
          tables.device_pack_summaries = tables.device_pack_summaries.filter(
            cached => cached.user_id !== row.user_id
          );
          bump(row.user_id);
          bump(row.user_id, 'problem_packs');
        }
      }
      return new Response(null, { status: 204 });
    }
    const offset = Number(url.searchParams.get('offset') ?? 0);
    rows = rows.slice(
      offset,
      offset + Math.min(137, Number(url.searchParams.get('limit') ?? 1000))
    );
    const result = rows.map(row =>
      projection(row, url.searchParams.get('select') ?? '*')
    );
    if (table === 'notebook_notes') {
      activeNoteReads++;
      peakNoteReads = Math.max(activeNoteReads, peakNoteReads);
      await new Promise(resolve => setTimeout(resolve, 0));
      activeNoteReads--;
    }
    return Response.json(result);
  };
  return {
    client: createClient('http://fixture.invalid', 'fixture-key', {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: fetcher },
    }),
    tables,
    objects,
    calls,
    bump,
    peakNoteReads: () => peakNoteReads,
    hook: (value?: typeof hook) => {
      hook = value;
    },
    fail: (value?: typeof fail) => {
      fail = value;
    },
  };
}
