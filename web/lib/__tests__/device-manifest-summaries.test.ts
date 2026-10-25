import { createHash } from 'node:crypto';
import { loadNoteStudyManifest, buildNotePack } from '@/lib/note-packs';
import { loadProblemStudyManifest } from '@/lib/problem-packs';
import {
  loadDevicePackArtifact,
  loadDeviceImageArtifact,
} from '@/lib/device-content-artifacts';
import { manifestClient } from '@/lib/test/device-manifest-client';
import {
  resolveManifestSummaries,
  packSourceKey,
} from '@/lib/device-manifest-summaries';

const user = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const origin = 'https://fixture.invalid';
const id = (n: number) =>
  '20000000-0000-4000-8000-' + String(n).padStart(12, '0');
function seedNotebooks(count = 3, notes = 2) {
  const h = manifestClient();
  for (let i = 0; i < count; i++) {
    h.tables.notebooks.push({
      id: id(i),
      user_id: user,
      title: 'Notebook ' + i,
    });
    h.tables.note_change_log.push({
      id: 'log-' + i,
      user_id: user,
      notebook_id: id(i),
      change_seq: i + 1,
    });
    for (let j = 0; j < notes; j++)
      h.tables.notebook_notes.push({
        id: id(10000 + i * notes + j),
        user_id: user,
        notebook_id: id(i),
        sort_index: j,
        revision: 1,
        title: 'Note',
        content: 'fixture body',
        assets: [],
      });
  }
  h.bump(user);
  return h;
}
function noteManifest(
  h: ReturnType<typeof manifestClient>,
  cursor = 0,
  snapshot?: string
) {
  return loadNoteStudyManifest(h.client, user, origin, cursor, 50, snapshot);
}
function bodyReads(h: ReturnType<typeof manifestClient>) {
  return h.calls.filter(call => call.url.pathname.endsWith('/notebook_notes'));
}
const writes = (h: ReturnType<typeof manifestClient>) =>
  h.calls.filter(
    call => call.method !== 'GET' && !call.url.pathname.includes('/rpc/')
  );

afterEach(() => vi.useRealTimers());

it('a valid 60-notebook second page reuses complete summaries with zero body reads, uploads or writes', async () => {
  const h = seedNotebooks(60, 30);
  const first = await noteManifest(h);
  expect(first.notebooks).toHaveLength(50);
  expect(first.has_more).toBe(true);
  expect(h.peakNoteReads()).toBe(2);
  expect(h.tables.device_pack_summaries).toHaveLength(60);
  expect(bodyReads(h)).toHaveLength(120); // Each collection includes its empty final page.
  const cold = {
    database_requests: h.calls.filter(call =>
      call.url.pathname.startsWith('/rest/')
    ).length,
    body_reads: bodyReads(h).length,
    storage_requests: h.calls.filter(call =>
      call.url.pathname.startsWith('/storage/')
    ).length,
  };
  h.calls.length = 0;
  const second = await noteManifest(h, 50, first.snapshot_id);
  expect(second.notebooks).toHaveLength(10);
  expect(second.snapshot_id).toBe(first.snapshot_id);
  expect(second.cursor).toBe('60');
  expect(second.has_more).toBe(false);
  expect(bodyReads(h)).toHaveLength(0);
  expect(writes(h)).toHaveLength(0);
  expect(h.calls).toHaveLength(6); // 2 revision reads + 2 source pages + 2 summary pages.
  console.info(
    'MANIFEST_CACHE_COMPARISON',
    JSON.stringify({
      notebooks: 60,
      notes_per_notebook: 30,
      max_parallel_body_reads: h.peakNoteReads(),
      cold,
      warm_second_page: {
        database_requests: h.calls.length,
        body_reads: bodyReads(h).length,
        writes: writes(h).length,
      },
      real_database: false,
      real_storage: false,
    })
  );
  expect(h.calls.every(call => !call.url.pathname.includes('/storage/'))).toBe(
    true
  );
  expect((await noteManifest(h)).notebooks).toEqual(first.notebooks);
});

it('rebuilds only a changed notebook and rejects an expired snapshot', async () => {
  const h = seedNotebooks();
  const first = await noteManifest(h);
  h.tables.notebook_notes[0].content = 'edited';
  h.tables.notebook_notes[0].revision++;
  h.tables.note_change_log[0].change_seq = 10;
  h.bump(user);
  h.calls.length = 0;
  await expect(noteManifest(h, 50, first.snapshot_id)).rejects.toMatchObject({
    code: 'snapshot_expired',
    status: 410,
  });
  expect(
    new Set(bodyReads(h).map(call => call.url.searchParams.get('notebook_id')))
  ).toEqual(new Set(['eq.' + id(0)]));
  const next = await noteManifest(h);
  expect(next.notebooks[0].pack!.sha256).not.toBe(
    first.notebooks[0].pack!.sha256
  );
  expect(next.notebooks.slice(1)).toEqual(first.notebooks.slice(1));
});

it('title, deletion and ownership changes refresh the list while old immutable packs stay downloadable', async () => {
  const h = seedNotebooks();
  const first = await noteManifest(h);
  const immutable = first.notebooks[0].pack!;
  h.tables.notebooks[0].title = 'Renamed';
  h.bump(user);
  h.calls.length = 0;
  const renamed = await noteManifest(h);
  expect(renamed.snapshot_id).not.toBe(first.snapshot_id);
  expect(renamed.notebooks[0].pack).toEqual(immutable);
  expect(bodyReads(h)).toHaveLength(0);
  h.tables.notebooks[0].archived_at = '2026-10-24T00:00:00Z';
  h.tables.notebooks[1].user_id = other;
  h.bump(user);
  await expect(noteManifest(h, 50, renamed.snapshot_id)).rejects.toMatchObject({
    status: 410,
  });
  expect((await noteManifest(h)).notebooks.map(row => row.notebook_id)).toEqual(
    [id(2)]
  );
  const old = await loadDevicePackArtifact({
    supabase: h.client,
    userId: user,
    domain: 'note_packs',
    logicalId: id(0),
    sha256: immutable.sha256,
  });
  expect(createHash('sha256').update(Buffer.from(old.body)).digest('hex')).toBe(
    immutable.sha256
  );
  expect(
    (await loadNoteStudyManifest(h.client, other, origin, 0)).notebooks.map(
      row => row.notebook_id
    )
  ).toEqual([id(1)]);
});

it('does not cache an omitted image; restoring its derivative changes SHA without editing the note', async () => {
  const h = seedNotebooks(1, 1);
  const imageId = 'a'.repeat(64),
    path = 'user/' + user + '/notes/n/derived/source.wqni';
  h.tables.notebook_notes[0].assets = [
    { image_id: imageId, display_path: path },
  ];
  const missing = await noteManifest(h);
  expect(h.tables.device_pack_summaries).toHaveLength(0);
  h.objects.set('problem-uploads/' + path, new Uint8Array([1, 2, 3]));
  const restored = await noteManifest(h);
  expect(restored.notebooks[0].pack!.sha256).not.toBe(
    missing.notebooks[0].pack!.sha256
  );
  expect(h.tables.device_pack_summaries).toHaveLength(1);
  // Detaching the original source does not remove the already copied image.
  h.objects.delete('problem-uploads/' + path);
  h.calls.length = 0;
  expect((await noteManifest(h)).snapshot_id).toBe(restored.snapshot_id);
  expect(writes(h)).toHaveLength(0);
  const image = await loadDeviceImageArtifact({
    supabase: h.client,
    userId: user,
    imageId,
  });
  expect(new Uint8Array(image.body)).toEqual(new Uint8Array([1, 2, 3]));
});

it('materialization touches unchanged pack/image pointers only after 24 hours or a clock rollback', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
  const h = seedNotebooks(1, 1),
    imageId = 'e'.repeat(64);
  const path = 'user/' + user + '/notes/n/derived/source.wqni';
  h.tables.notebook_notes[0].assets = [
    { image_id: imageId, display_path: path },
  ];
  h.objects.set('problem-uploads/' + path, new Uint8Array([1]));
  const first = await buildNotePack(h.client, user, id(0), {
    materialize: true,
  });
  h.calls.length = 0;
  expect(
    (await buildNotePack(h.client, user, id(0), { materialize: true })).sha256
  ).toBe(first.sha256);
  expect(writes(h)).toHaveLength(0);
  vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
  await buildNotePack(h.client, user, id(0), { materialize: true });
  expect(writes(h).map(call => call.url.pathname.split('/').at(-1))).toEqual([
    'device_image_artifacts',
    'device_pack_artifacts',
  ]);
  h.calls.length = 0;
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  await buildNotePack(h.client, user, id(0), { materialize: true });
  expect(writes(h)).toHaveLength(2);
  h.calls.length = 0;
  await buildNotePack(h.client, user, id(0), { materialize: true });
  expect(writes(h)).toHaveLength(0);
});

it('an observed missing immutable pack invalidates its summary and can be rematerialized', async () => {
  const h = seedNotebooks(1, 1);
  const first = await noteManifest(h),
    pack = first.notebooks[0].pack!;
  const artifact = h.tables.device_pack_artifacts[0];
  h.objects.delete('problem-uploads/' + artifact.storage_path);
  await expect(
    loadDevicePackArtifact({
      supabase: h.client,
      userId: user,
      domain: 'note_packs',
      logicalId: id(0),
      sha256: pack.sha256,
    })
  ).rejects.toMatchObject({ status: 410 });
  expect(h.tables.device_pack_summaries).toHaveLength(0);
  expect((await noteManifest(h)).notebooks[0].pack).toEqual(pack);
  expect(h.objects.has('problem-uploads/' + artifact.storage_path)).toBe(true);
});

it('an image removal changes source identity even if an old builder inserts its cache pointer late', async () => {
  const h = seedNotebooks(1, 1);
  const imageId = 'b'.repeat(64),
    path = 'user/' + user + '/notes/n/derived/b.wqni';
  h.tables.notebook_notes[0].assets = [
    { image_id: imageId, display_path: path },
  ];
  h.objects.set('problem-uploads/' + path, new Uint8Array([1]));
  const first = await noteManifest(h);
  const oldCache = { ...h.tables.device_pack_summaries[0] };
  h.objects.delete('problem-uploads/' + path);
  h.objects.delete(
    'problem-uploads/' + h.tables.device_image_artifacts[0].storage_path
  );
  await expect(
    loadDeviceImageArtifact({ supabase: h.client, userId: user, imageId })
  ).rejects.toMatchObject({ status: 404 });
  expect(h.tables.device_pack_summaries).toHaveLength(0);
  h.tables.device_pack_summaries.push(oldCache);
  const next = await noteManifest(h);
  expect(next.notebooks[0].pack!.sha256).not.toBe(
    first.notebooks[0].pack!.sha256
  );
});

it('a failed builder waits for the other started build and never publishes partial pointers', async () => {
  const h = seedNotebooks(0);
  let release!: () => void;
  const pending = new Promise<void>(resolve => (release = resolve));
  const build = vi.fn(async (source: { id: string }) => {
    if (source.id === 'a') throw new Error('build failed');
    await pending;
    return {
      sha256: 'c'.repeat(64),
      pack_revision: 1,
      entry_count: 1,
      byte_size: 1,
    };
  });
  let settled = false;
  const outcome = resolveManifestSummaries({
    supabase: h.client,
    userId: user,
    domain: 'note_packs',
    revision: '1',
    sources: ['a', 'b', 'c'].map(id => ({ id, source_key: packSourceKey(id) })),
    build,
  }).catch(error => {
    settled = true;
    return error;
  });
  await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  release();
  expect(await outcome).toMatchObject({ message: 'build failed' });
  expect(build).toHaveBeenCalledTimes(2);
  expect(h.tables.device_pack_summaries).toHaveLength(0);
});

it('pages through 1505 lightweight heads and summaries under a 137-row ceiling', async () => {
  const h = seedNotebooks(1505, 0);
  for (let index = 0; index < 1505; index++) {
    const body = JSON.stringify({
      v: 1,
      notebook_id: id(index),
      content_revision: index + 1,
      count: 0,
    });
    const sha256 = createHash('sha256').update(body).digest('hex');
    const headKey = createHash('sha256')
      .update(JSON.stringify([index + 1, [], 0]))
      .digest('hex');
    h.tables.device_pack_artifacts.push({
      user_id: user,
      domain: 'note_packs',
      logical_id: id(index),
      sha256,
    });
    h.tables.device_pack_summaries.push({
      user_id: user,
      domain: 'note_packs',
      logical_id: id(index),
      source_key: packSourceKey([1, headKey]),
      sha256,
      pack_revision: index + 1,
      entry_count: 0,
      byte_size: Buffer.byteLength(body),
    });
  }
  const first = await noteManifest(h);
  expect(first.notebooks).toHaveLength(50);
  const last = await noteManifest(h, 1500, first.snapshot_id);
  expect(last.notebooks.map(row => row.notebook_id)).toEqual(
    Array.from({ length: 5 }, (_, index) => id(1500 + index))
  );
  expect(last.cursor).toBe('1505');
  expect(last.has_more).toBe(false);
  expect(bodyReads(h)).toHaveLength(0);
  expect(writes(h)).toHaveLength(0);
}, 15000);

it('retries a revision race and publishes only the stable summaries', async () => {
  const h = seedNotebooks(3, 1);
  let edited = false;
  h.hook(url => {
    if (!edited && url.pathname.endsWith('/notebook_notes')) {
      edited = true;
      h.tables.notebook_notes[0].content = 'concurrent edit';
      h.tables.notebook_notes[0].revision++;
      h.tables.note_change_log[0].change_seq = 20;
      h.bump(user);
    }
  });
  const first = await noteManifest(h);
  expect(first.notebooks[0].content_revision).toBe(20);
  expect(h.tables.device_pack_summaries).toHaveLength(3);
  expect(
    h.calls.filter(
      call =>
        call.method === 'POST' &&
        call.url.pathname.endsWith('/device_pack_summaries')
    )
  ).toHaveLength(1);
  expect((await noteManifest(h)).snapshot_id).toBe(first.snapshot_id);
});

it('continuous concurrent writes return 410 without publishing mixed summaries', async () => {
  const h = seedNotebooks(3, 1);
  h.hook(url => {
    if (url.pathname.endsWith('/notebook_notes')) h.bump(user);
  });
  await expect(noteManifest(h)).rejects.toMatchObject({
    code: 'snapshot_expired',
    status: 410,
  });
  expect(h.tables.device_pack_summaries).toHaveLength(0);
});

it('a summary lookup failure fails closed rather than returning a partial list', async () => {
  const h = seedNotebooks();
  h.fail(url =>
    url.pathname.endsWith('/device_pack_summaries')
      ? 'cache unavailable'
      : undefined
  );
  await expect(noteManifest(h)).rejects.toThrow('cache unavailable');
  expect(bodyReads(h)).toHaveLength(0);
});

it('clock-only smart membership changes invalidate a cached problem pack using projected IDs', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
  const h = manifestClient();
  h.tables.problem_sets.push({
    id: id(0),
    user_id: user,
    name: 'Smart',
    is_smart: true,
    subject_id: id(9),
    filter_config: { days_since_review: 1, include_never_reviewed: false },
    updated_at: '2026-10-20T00:00:00Z',
  });
  for (let i = 0; i < 2; i++)
    h.tables.problems.push({
      id: id(100 + i),
      user_id: user,
      subject_id: id(9),
      title: 'Problem',
      content: 'fixture',
      parts: [{ index: 1, type: 'essay', full_marks: 1, content: 'fixture' }],
      source: {},
      status: 'wrong',
      assets: [],
      solution_assets: [],
      revision: 1,
      created_at: '2026-10-20T00:00:00Z',
      updated_at: '2026-10-20T00:00:00Z',
      last_reviewed_date: i ? '2026-10-23T00:00:01Z' : '2026-10-22T00:00:00Z',
    });
  h.bump(user, 'problem_packs');
  const load = (snapshot?: string) =>
    loadProblemStudyManifest(h.client as any, user, origin, 0, 50, snapshot);
  const first = await load();
  expect(first.problem_sets[0].pack!.entry_count).toBe(1);
  h.calls.length = 0;
  expect((await load()).snapshot_id).toBe(first.snapshot_id);
  expect(writes(h)).toHaveLength(0);
  expect(
    h.calls
      .filter(call => call.url.pathname.endsWith('/problems'))
      .every(call => call.url.searchParams.get('select') === 'id')
  ).toBe(true);
  vi.setSystemTime(new Date('2026-10-24T00:00:02Z'));
  await expect(load(first.snapshot_id)).rejects.toMatchObject({ status: 410 });
  const next = await load();
  expect(next.problem_sets[0].pack!.entry_count).toBe(2);
  expect(next.snapshot_id).not.toBe(first.snapshot_id);
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
  expect((await load()).problem_sets[0].pack!.entry_count).toBe(1);
});
