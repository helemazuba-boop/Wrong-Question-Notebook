import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { FilterConfig } from './types';
import { getFilteredProblems } from './review-utils';
import { readAllQueryPages } from './query-pagination';
import { htmlToEsp32Content, latexToEsp32Text } from './esp32-content';
import { StoredProblemPartsSchema, FilterConfigSchema } from './schemas';
import { ANSWER_CONFIG_CONSTANTS } from './constants';
import {
  PROBLEM_PACK_MAX_BYTES,
  PROBLEM_PACK_MAX_ENTRIES,
  PROBLEM_PACK_MAX_LINE_BYTES,
  PROBLEM_PACK_SCHEMA_VERSION,
} from './problem-study-v1';
import {
  materializeDevicePackArtifact,
  registerDeviceImageArtifacts,
} from './device-content-artifacts';
import {
  DeviceManifestChanged,
  guardManifestRead,
  packSourceKey,
  readManifestRevision,
  resolveManifestSummaries,
} from './device-manifest-summaries';

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
  cacheable: boolean;
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

interface ProblemPackChoice {
  id: string;
  text: string;
}

/**
 * Choice text is plain text that may embed $...$ LaTeX (rendered by MathText
 * on the web). Flatten each math segment with latexToEsp32Text and collapse
 * every whitespace run so a single option can never inject extra markdown
 * blocks (headings, tables, ...) into the device's composed body text.
 */
function mathTextToEsp32Text(text: string): string {
  return text
    .replace(/\$([^$\n]+?)\$/g, (_match, latex: string) =>
      latexToEsp32Text(latex)
    )
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function clampChoiceId(id: string): string {
  return Array.from(id).slice(0, 10).join('');
}

function clampChoiceText(text: string): string {
  const chars = Array.from(text);
  const maxChars = ANSWER_CONFIG_CONSTANTS.MCQ.MAX_CHOICE_TEXT_LENGTH;
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * Projects parts[].answer_config.choices into the pack's display-ready
 * option list. answer_config is unvalidated jsonb at rest, so every entry is
 * checked defensively and clamped to the contract bounds.
 */
function partChoicesOf(
  answerConfig: Record<string, unknown> | null | undefined
): ProblemPackChoice[] {
  if (!answerConfig || typeof answerConfig !== 'object') return [];
  const raw = (answerConfig as { choices?: unknown }).choices;
  if (!Array.isArray(raw)) return [];
  const choices: ProblemPackChoice[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { id, text } = value as { id?: unknown; text?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    choices.push({
      id: clampChoiceId(id),
      text: clampChoiceText(
        mathTextToEsp32Text(typeof text === 'string' ? text : '')
      ),
    });
    if (choices.length >= ANSWER_CONFIG_CONSTANTS.MCQ.MAX_CHOICES) break;
  }
  return choices;
}

/**
 * Serialises one problem row into its pack JSONL record, or null when the
 * stored parts do not parse (a corrupt row must not 500 the whole pack).
 * Every key is emitted even when empty so the row layout stays uniform for
 * the device parser; `choices` is the one optional key (omitted unless the
 * part actually has options).
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
  const parts = parsedParts.data.map(part => {
    const choices = partChoicesOf(
      part.mcq_choices?.length
        ? { choices: part.mcq_choices }
        : part.answer_config
    );
    return {
      index: part.index,
      label: part.label ?? '',
      type: part.type,
      full_marks: part.full_marks ?? 0,
      content_text: htmlToEsp32Content(part.content).text,
      answer_text: partAnswerText(part.answer_config, part.correct_answer),
      ...(choices.length > 0 ? { choices } : {}),
    };
  });
  const problemImages = imagePairsOf(row.assets, availableImageIds);
  const solutionImages = imagePairsOf(row.solution_assets, availableImageIds);
  const record = {
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
  };
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line, 'utf8') <= PROBLEM_PACK_MAX_LINE_BYTES) {
    return line;
  }
  // The device rejects the whole pack when a single JSONL row exceeds its
  // line bound (kMaxPackLineBytes), so drop the optional options rather than
  // break the set; only skip the row when the pre-existing fields alone are
  // already over the bound.
  const withoutChoices = JSON.stringify({
    ...record,
    parts: parts.map(part => ({ ...part, choices: undefined })),
  });
  if (
    Buffer.byteLength(withoutChoices, 'utf8') <= PROBLEM_PACK_MAX_LINE_BYTES
  ) {
    console.warn(
      `[problem-pack] dropping choices for problem ${row.id}: row exceeds ${PROBLEM_PACK_MAX_LINE_BYTES} bytes`
    );
    return withoutChoices;
  }
  console.warn(
    `[problem-pack] skipping problem ${row.id}: row exceeds ${PROBLEM_PACK_MAX_LINE_BYTES} bytes`
  );
  return null;
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
  set: ProblemSetRow,
  asOf?: Date
): Promise<ProblemRowSource[]> {
  if (set.is_smart) {
    // Smart set: snapshot of the filter at build time; membership changes
    // surface as a new pack sha on the next manifest round.
    const filterConfig = smartFilterOf(set);
    const filtered = await getFilteredProblems(
      supabase,
      userId,
      set.subject_id,
      filterConfig,
      undefined,
      undefined,
      { now: asOf }
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
  const { data: junction, error: junctionError } = await readAllQueryPages(
    (offset, limit) =>
      supabase
        .from('problem_set_problems')
        .select('id, problem_id, added_at')
        .eq('problem_set_id', set.id)
        .eq('user_id', userId)
        .order('added_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
  );
  if (junctionError) {
    throw new ProblemStudyToolError(
      'database_error',
      junctionError.message,
      500
    );
  }
  const orderedIds = (junction || []).map(link => link.problem_id);
  if (orderedIds.length === 0) return [];

  const problems: ProblemRowSource[] = [];
  // Bound both the result page and the URL's in() list. A large manual set
  // must not overflow an HTTP request line or the PostgREST row ceiling.
  for (let start = 0; start < orderedIds.length; start += 100) {
    const { data, error } = await readAllQueryPages((offset, limit) =>
      supabase
        .from('problems')
        .select(PROBLEM_ROW_COLUMNS)
        .eq('user_id', userId)
        .in('id', orderedIds.slice(start, start + 100))
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
    );
    if (error) {
      throw new ProblemStudyToolError('database_error', error.message, 500);
    }
    problems.push(...((data ?? []) as unknown as ProblemRowSource[]));
  }
  const byId = new Map(problems.map(row => [row.id, row]));
  return orderedIds
    .map(id => byId.get(id))
    .filter((row): row is ProblemRowSource => row !== undefined);
}

function smartFilterOf(
  set: Pick<ProblemSetRow, 'filter_config'>
): FilterConfig {
  const parsed = FilterConfigSchema.safeParse(set.filter_config);
  if (!parsed.success)
    throw new ProblemStudyToolError(
      'invalid_filter_config',
      'Smart problem set has an invalid filter_config',
      400
    );
  return {
    ...parsed.data,
    days_since_review: parsed.data.days_since_review ?? null,
  };
}

export async function buildProblemPack(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemSetId: string,
  options: { materialize?: boolean; asOf?: Date } = {}
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

  const members = (
    await loadMemberProblems(supabase, userId, set, options.asOf)
  ).slice(0, PROBLEM_PACK_MAX_ENTRIES);

  let availableImageIds: Set<string> | null = null;
  let cacheable = true;
  if (options.materialize) {
    const registration = await registerDeviceImageArtifacts(
      supabase,
      userId,
      members.flatMap(row => [row.assets, row.solution_assets])
    );
    availableImageIds = new Set(
      registration.registered.map(artifact => artifact.image_id)
    );
    cacheable = registration.missing.length === 0;
  }

  // The device caps a pack at PROBLEM_PACK_MAX_BYTES and the manifest zod
  // schema rejects anything larger, so stop adding rows before the budget is
  // spent rather than 500 the whole manifest for every set.
  const rowLines: string[] = [];
  let packBytes = 0;
  const packBudget = PROBLEM_PACK_MAX_BYTES - 1024; // meta line + LF slack
  for (const member of members) {
    const line = packRowOf(member, availableImageIds);
    if (line === null) continue;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (packBytes + lineBytes > packBudget) {
      console.warn(
        `[problem-pack] set ${problemSetId}: stopping at ${rowLines.length} rows (pack byte budget)`
      );
      break;
    }
    rowLines.push(line);
    packBytes += lineBytes;
  }

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
    cacheable,
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await loadStableProblemManifest(
        supabase,
        userId,
        origin,
        cursor,
        limit,
        expectedSnapshotId
      );
    } catch (error) {
      if (!(error instanceof DeviceManifestChanged)) throw error;
      if (expectedSnapshotId || attempt === 1)
        throw new ProblemStudyToolError(
          'snapshot_expired',
          'The problem manifest changed; restart from cursor zero',
          410
        );
    }
  }
  throw new Error('Unreachable manifest retry');
}

async function loadStableProblemManifest(
  supabase: SupabaseClient<Database>,
  userId: string,
  origin: string,
  cursor: number,
  limit: number,
  expectedSnapshotId?: string
): Promise<ProblemManifestResult> {
  const pageSize = Math.min(Math.max(limit, 1), 100);
  const revisionBefore = await readManifestRevision(
    supabase,
    userId,
    'problem_packs'
  );
  const asOf = new Date();
  const { data, error } = await guardManifestRead({
    supabase,
    userId,
    domain: 'problem_packs',
    revision: revisionBefore,
    read: () =>
      readAllQueryPages((offset, limit) =>
        supabase
          .from('problem_sets')
          .select('id, name, subject_id, is_smart, filter_config')
          .eq('user_id', userId)
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1)
      ),
  });
  if (error) {
    throw new ProblemStudyToolError('database_error', error.message, 500);
  }

  const sources = [];
  for (const row of data || []) {
    let dynamicMembers: unknown = null;
    if (row.is_smart) {
      const filter = smartFilterOf(row);
      if (filter.days_since_review != null) {
        // A clock-only eligibility change has no mutation/revision trigger.
        // Read identities rather than pack bodies; use exactly the same filter
        // and cutoff as the subsequent materialization.
        const members = await getFilteredProblems(
          supabase,
          userId,
          row.subject_id,
          filter,
          undefined,
          undefined,
          { columns: 'id', now: asOf }
        );
        dynamicMembers = members.map(member => member.id);
      }
    }
    sources.push({
      ...row,
      source_key: packSourceKey([
        PROBLEM_PACK_SCHEMA_VERSION,
        revisionBefore,
        row.id,
        dynamicMembers,
      ]),
    });
  }
  const summaries = await resolveManifestSummaries({
    supabase,
    userId,
    domain: 'problem_packs',
    revision: revisionBefore,
    sources,
    build: row =>
      buildProblemPack(supabase, userId, row.id, { materialize: true, asOf }),
  });
  const problemSets = summaries.map(({ source: row, pack }) => {
    return {
      problem_set_id: row.id,
      name: row.name,
      is_smart: row.is_smart,
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
  });

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
