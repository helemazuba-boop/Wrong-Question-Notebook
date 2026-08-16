import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { FilterConfig } from './types';
import { getFilteredProblems } from './review-utils';
import { htmlToEsp32Content } from './esp32-content';
import { StoredProblemPartsSchema } from './schemas';
import {
  PROBLEM_PACK_MAX_ENTRIES,
  PROBLEM_PACK_SCHEMA_VERSION,
} from './problem-study-v1';
import {
  materializeDevicePackArtifact,
  registerDeviceImageArtifacts,
} from './device-content-artifacts';

// Deterministic per-problem-set packs, mirroring lib/note-packs.ts. There is
// no problem_packs table: a pack is computed on demand from the set's member
// problems (manual sets via the junction table in added_at order, smart sets
// as a filter snapshot in updated_at-desc order). The manifest and the
// download route both call buildProblemPack so their SHA-256 values agree.

export class ProblemStudyToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ProblemStudyToolError';
  }
}

interface ProblemRowSource {
  id: string;
  title: string;
  content: string | null;
  parts: unknown;
  source: unknown;
  status: string;
  is_optional: boolean | null;
  assets: unknown;
  solution_assets: unknown;
  updated_at: string | null;
}

export interface ProblemPackResult {
  problem_set_id: string;
  name: string;
  is_smart: boolean;
  pack_revision: number;
  sha256: string;
  entry_count: number;
  byte_size: number;
  body: string;
}

const PROBLEM_ROW_COLUMNS =
  'id, title, content, parts, source, status, is_optional, assets, solution_assets, updated_at';

function imagePairsOf(
  assets: unknown,
  availableImageIds: Set<string> | null
): { imageIds: string[]; gray4ImageIds: Array<string | null> } {
  const imageIds: string[] = [];
  const gray4ImageIds: Array<string | null> = [];
  if (!Array.isArray(assets)) return { imageIds, gray4ImageIds };
  for (const value of assets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const asset = value as {
      image_id?: unknown;
      gray4_image_id?: unknown;
    };
    const bw1 =
      typeof asset.image_id === 'string' &&
      (availableImageIds === null || availableImageIds.has(asset.image_id))
        ? asset.image_id
        : null;
    const gray4 =
      typeof asset.gray4_image_id === 'string' &&
      (availableImageIds === null ||
        availableImageIds.has(asset.gray4_image_id))
        ? asset.gray4_image_id
        : null;
    const primary = bw1 ?? gray4;
    if (primary === null) continue;
    imageIds.push(primary);
    gray4ImageIds.push(gray4);
    if (imageIds.length >= 8) break;
  }
  return { imageIds, gray4ImageIds };
}

/**
 * Display-ready answer line for one part. The device never parses
 * answer_config: MCQ answers collapse to their choice-id letters ("BD"),
 * everything else falls back to the part's correct_answer text.
 */
function partAnswerText(
  answerConfig: Record<string, unknown> | null | undefined,
  correctAnswer: string | undefined
): string {
  if (answerConfig && typeof answerConfig === 'object') {
    if (
      answerConfig.type === 'mcq' &&
      typeof answerConfig.correct_choice_id === 'string'
    ) {
      return answerConfig.correct_choice_id;
    }
    if (
      answerConfig.type === 'multi_mcq' &&
      Array.isArray(answerConfig.correct_choice_ids)
    ) {
      const ids = answerConfig.correct_choice_ids.filter(
        (id): id is string => typeof id === 'string'
      );
      if (ids.length > 0) return [...ids].sort().join('');
    }
    if (answerConfig.type === 'short') {
      if (
        answerConfig.mode === 'text' &&
        Array.isArray(answerConfig.acceptable_answers) &&
        typeof answerConfig.acceptable_answers[0] === 'string'
      ) {
        return answerConfig.acceptable_answers[0];
      }
      if (answerConfig.mode === 'numeric') {
        const numeric = answerConfig.numeric_config as
          { correct_value?: unknown; unit?: unknown } | undefined;
        if (typeof numeric?.correct_value === 'number') {
          const unit = typeof numeric.unit === 'string' ? numeric.unit : '';
          return `${numeric.correct_value}${unit}`;
        }
      }
    }
  }
  return correctAnswer ?? '';
}

/**
 * Serialises one problem row into its pack JSONL record, or null when the
 * stored parts do not parse (a corrupt row must not 500 the whole pack).
 * Every key is emitted even when empty so the row layout stays uniform for
 * the device parser.
 */
function packRowOf(
  row: ProblemRowSource,
  availableImageIds: Set<string> | null = null
): string | null {
  const parsedParts = StoredProblemPartsSchema.safeParse(row.parts);
  if (!parsedParts.success) {
    console.warn(`[problem-pack] skipping problem ${row.id}: bad parts`);
    return null;
  }
  const parts = parsedParts.data.map(part => ({
    index: part.index,
    label: part.label ?? '',
    type: part.type,
    full_marks: part.full_marks ?? 0,
    content_text: htmlToEsp32Content(part.content).text,
    answer_text: partAnswerText(part.answer_config, part.correct_answer),
  }));
  const problemImages = imagePairsOf(row.assets, availableImageIds);
  const solutionImages = imagePairsOf(row.solution_assets, availableImageIds);
  return JSON.stringify({
    problem_id: row.id,
    title: row.title,
    content_text: htmlToEsp32Content(row.content).text,
    parts,
    source:
      row.source && typeof row.source === 'object' && !Array.isArray(row.source)
        ? row.source
        : {},
    status: row.status,
    is_optional: row.is_optional === true,
    image_ids: problemImages.imageIds,
    gray4_image_ids: problemImages.gray4ImageIds,
    solution_image_ids: solutionImages.imageIds,
    solution_gray4_image_ids: solutionImages.gray4ImageIds,
  });
}

function epochSecondsOf(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

interface ProblemSetRow {
  id: string;
  name: string;
  subject_id: string;
  is_smart: boolean;
  filter_config: unknown;
  updated_at: string | null;
}

async function loadMemberProblems(
  supabase: SupabaseClient<Database>,
  userId: string,
  set: ProblemSetRow
): Promise<ProblemRowSource[]> {
  if (set.is_smart) {
    // Smart set: snapshot of the filter at build time; membership changes
    // surface as a new pack sha on the next manifest round.
    const raw = (set.filter_config ?? {}) as Partial<FilterConfig>;
    const filterConfig: FilterConfig = {
      tag_ids: raw.tag_ids ?? [],
      statuses: raw.statuses ?? [],
      problem_types: raw.problem_types ?? [],
      days_since_review: raw.days_since_review ?? null,
      include_never_reviewed: raw.include_never_reviewed ?? true,
    };
    const filtered = await getFilteredProblems(
      supabase,
      userId,
      set.subject_id,
      filterConfig
    );
    const rows = filtered as unknown as ProblemRowSource[];
    return [...rows].sort((a, b) => {
      const delta = epochSecondsOf(b.updated_at) - epochSecondsOf(a.updated_at);
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
  }

  // Manual set: junction order (added_at asc = the order the user built the
  // set in). Two explicit queries instead of an embedded join so the column
  // list stays type-checked.
  const { data: junction, error: junctionError } = await supabase
    .from('problem_set_problems')
    .select('problem_id, added_at')
    .eq('problem_set_id', set.id)
    .eq('user_id', userId)
    .order('added_at', { ascending: true })
    .order('id', { ascending: true });
  if (junctionError) {
    throw new ProblemStudyToolError(
      'database_error',
      junctionError.message,
      500
    );
  }
  const orderedIds = (junction || []).map(link => link.problem_id);
  if (orderedIds.length === 0) return [];

  const { data: problems, error: problemsError } = await supabase
    .from('problems')
    .select(PROBLEM_ROW_COLUMNS)
    .eq('user_id', userId)
    .in('id', orderedIds);
  if (problemsError) {
    throw new ProblemStudyToolError(
      'database_error',
      problemsError.message,
      500
    );
  }
  const byId = new Map(
    ((problems || []) as unknown as ProblemRowSource[]).map(row => [
      row.id,
      row,
    ])
  );
  return orderedIds
    .map(id => byId.get(id))
    .filter((row): row is ProblemRowSource => row !== undefined);
}

export async function buildProblemPack(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemSetId: string,
  options: { materialize?: boolean } = {}
): Promise<ProblemPackResult> {
  const { data: set, error } = await supabase
    .from('problem_sets')
    .select('id, name, subject_id, is_smart, filter_config, updated_at')
    .eq('id', problemSetId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new ProblemStudyToolError('database_error', error.message, 500);
  }
  if (!set) {
    throw new ProblemStudyToolError(
      'problem_set_not_found',
      'Problem set not found',
      404
    );
  }

  const members = (await loadMemberProblems(supabase, userId, set)).slice(
    0,
    PROBLEM_PACK_MAX_ENTRIES
  );

  let availableImageIds: Set<string> | null = null;
  if (options.materialize) {
    const registration = await registerDeviceImageArtifacts(
      supabase,
      userId,
      members.flatMap(row => [row.assets, row.solution_assets])
    );
    availableImageIds = new Set(
      registration.registered.map(artifact => artifact.image_id)
    );
  }

  const rowLines = members
    .map(row => packRowOf(row, availableImageIds))
    .filter((line): line is string => line !== null);

  // pack_revision advances whenever the set or any member problem changes;
  // freshness detection itself rides on the sha256 (manifest compare).
  const packRevision = Math.max(
    epochSecondsOf(set.updated_at),
    ...members.map(row => epochSecondsOf(row.updated_at)),
    0
  );

  // PROBLEM_PACK_V1: a metadata line followed by one JSONL record per
  // problem. Fixed key order keeps the bytes (and therefore the SHA) stable.
  const lines = [
    JSON.stringify({
      v: PROBLEM_PACK_SCHEMA_VERSION,
      problem_set_id: set.id,
      pack_revision: packRevision,
      count: rowLines.length,
    }),
    ...rowLines,
  ];
  const body = lines.join('\n');
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');

  if (options.materialize) {
    await materializeDevicePackArtifact({
      supabase,
      userId,
      domain: 'problem_packs',
      logicalId: problemSetId,
      revision: packRevision,
      sha256,
      body,
    });
  }

  return {
    problem_set_id: set.id,
    name: set.name,
    is_smart: set.is_smart,
    pack_revision: packRevision,
    sha256,
    entry_count: rowLines.length,
    byte_size: Buffer.byteLength(body, 'utf8'),
    body,
  };
}

export interface ProblemManifestResult {
  cursor: string;
  has_more: boolean;
  revision: number;
  snapshot_id: string;
  problem_sets: Array<{
    problem_set_id: string;
    name: string;
    is_smart: boolean;
    deleted: boolean;
    pack: {
      pack_id: string;
      pack_revision: number;
      schema_version: number;
      format: 'jsonl';
      compression: 'zlib';
      entry_count: number;
      byte_size: number;
      sha256: string;
      download_url: string;
    } | null;
  }>;
}

/**
 * Lists the caller's problem sets (ordered by id) with a deterministic pack
 * summary each, paginated by an integer offset cursor -- the same
 * offset-relist semantics as the note manifest. pack_id is the problem set id
 * because a pack is exactly one set's member problems.
 */
export async function loadProblemStudyManifest(
  supabase: SupabaseClient<Database>,
  userId: string,
  origin: string,
  cursor: number,
  limit = 50,
  expectedSnapshotId?: string
): Promise<ProblemManifestResult> {
  const pageSize = Math.min(Math.max(limit, 1), 100);
  const { data, error } = await supabase
    .from('problem_sets')
    .select('id, name')
    .eq('user_id', userId)
    .order('id', { ascending: true });
  if (error) {
    throw new ProblemStudyToolError('database_error', error.message, 500);
  }

  const rows = (data || []) as Array<{ id: string; name: string }>;
  const problemSets = await Promise.all(
    rows.map(async row => {
      const pack = await buildProblemPack(supabase, userId, row.id, {
        materialize: true,
      });
      return {
        problem_set_id: row.id,
        name: row.name,
        is_smart: pack.is_smart,
        deleted: false,
        pack: {
          pack_id: row.id,
          pack_revision: pack.pack_revision,
          schema_version: PROBLEM_PACK_SCHEMA_VERSION,
          format: 'jsonl' as const,
          compression: 'zlib' as const,
          entry_count: pack.entry_count,
          byte_size: pack.byte_size,
          sha256: pack.sha256,
          download_url: `${origin}/api/esp32/v3/problems/packs/${row.id}/${pack.sha256}`,
        },
      };
    })
  );

  const snapshotBody = JSON.stringify(problemSets);
  const snapshotId = createHash('sha256').update(snapshotBody).digest('hex');
  if (expectedSnapshotId && expectedSnapshotId !== snapshotId) {
    throw new ProblemStudyToolError(
      'snapshot_expired',
      'The problem manifest changed; restart from cursor zero',
      410
    );
  }
  const page = problemSets.slice(cursor, cursor + pageSize);
  const hasMore = cursor + pageSize < problemSets.length;
  const revision = problemSets.reduce(
    (max, problemSet) => Math.max(max, problemSet.pack?.pack_revision ?? 0),
    0
  );

  return {
    cursor: String(cursor + page.length),
    has_more: hasMore,
    revision,
    snapshot_id: snapshotId,
    problem_sets: page,
  };
}

export async function getDownloadableProblemPack(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemSetId: string
): Promise<ProblemPackResult> {
  return buildProblemPack(supabase, userId, problemSetId);
}
