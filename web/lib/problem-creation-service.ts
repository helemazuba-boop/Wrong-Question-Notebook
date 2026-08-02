import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import { CONTENT_LIMIT_CONSTANTS, FILE_CONSTANTS } from '@/lib/constants';
import { checkContentLimit } from '@/lib/content-limits';
import { convertMathTextToTipTapHtml } from '@/lib/math-to-tiptap';
import {
  extractProblemFromImages,
  type ProblemExtractionImage,
  type ProblemExtractionResult,
} from '@/lib/problem-extraction-service';
import type { ExtractedPart, ParsedExtraction } from '@/lib/problem-extraction';
import type { ProblemAsset } from '@/lib/schemas';
import { deriveProblemImageAssets } from '@/lib/problem-image-service';
import {
  DEFAULT_PRESET_SUBJECT_NAME,
  ensurePresetSubjects,
} from '@/lib/subject-presets';
import { revalidateProblemComprehensive } from '@/lib/cache-invalidation';

export interface CreateProblemFromImagesInput {
  request_id: string;
  images: ProblemExtractionImage[];
  subject_id?: string | null;
  problem_set_id?: string | null;
  save_source_images?: boolean;
}

export interface CreatedProblemFromImages {
  problem: {
    id: string;
    subject_id: string;
    title: string;
    content: string;
    parts: Json;
    status: Database['public']['Enums']['problem_status_enum'];
    assets: Json;
    tags: Array<{ id: string; name: string }>;
    created_at: string;
  };
  extraction: {
    suggest_image_asset: boolean;
    confidence: ParsedExtraction['confidence'];
    warnings: string[];
  };
  problem_set_id: string | null;
  replayed: boolean;
  quota: ProblemExtractionResult['quota'] | null;
}

export class ProblemCreationServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ProblemCreationServiceError';
  }
}

function deterministicProblemId(userId: string, requestId: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`wqn:mcp:create-problem:${userId}:${requestId}`)
      .digest()
      .subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function imageFingerprint(images: ProblemExtractionImage[]): string[] {
  return images.map(image =>
    createHash('sha256')
      .update(image.mime_type)
      .update('\0')
      .update(image.data)
      .digest('hex')
  );
}

function requestFingerprint(input: CreateProblemFromImagesInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        subject_id: input.subject_id ?? null,
        problem_set_id: input.problem_set_id ?? null,
        save_source_images: input.save_source_images ?? null,
        images: imageFingerprint(input.images),
      })
    )
    .digest('hex');
}

async function resolveSubject(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId?: string | null,
  problemSetId?: string | null
): Promise<{ subjectId: string; problemSetId: string | null }> {
  let setSubjectId: string | null = null;
  if (problemSetId) {
    const { data, error } = await supabase
      .from('problem_sets')
      .select('id, subject_id')
      .eq('id', problemSetId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new ProblemCreationServiceError(
        'database_error',
        error.message,
        500,
        true
      );
    }
    if (!data) {
      throw new ProblemCreationServiceError(
        'problem_set_not_found',
        'Problem set not found',
        404
      );
    }
    setSubjectId = data.subject_id;
  }

  if (subjectId && setSubjectId && subjectId !== setSubjectId) {
    throw new ProblemCreationServiceError(
      'subject_mismatch',
      'The selected problem set belongs to a different subject',
      409
    );
  }
  const requested = subjectId || setSubjectId;
  if (requested) {
    const { data, error } = await supabase
      .from('subjects')
      .select('id')
      .eq('id', requested)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      throw new ProblemCreationServiceError(
        'database_error',
        error.message,
        500,
        true
      );
    }
    if (!data) {
      throw new ProblemCreationServiceError(
        'subject_not_found',
        'Subject not found',
        404
      );
    }
    return { subjectId: requested, problemSetId: problemSetId || null };
  }

  // The current problem schema still requires a subject FK. Preserve the
  // product-level optional subject contract by resolving the existing
  // "未分类" attachment internally instead of making the MCP caller pick one.
  await ensurePresetSubjects(supabase, userId);
  const { data, error } = await supabase
    .from('subjects')
    .select('id')
    .eq('user_id', userId)
    .eq('name', DEFAULT_PRESET_SUBJECT_NAME)
    .maybeSingle();
  if (error || !data) {
    throw new ProblemCreationServiceError(
      'default_subject_unavailable',
      'Unable to resolve the uncategorized subject',
      503,
      true
    );
  }
  return { subjectId: data.id, problemSetId: null };
}

function validChoiceIds(part: ExtractedPart): string[] {
  const available = new Set((part.mcq_choices ?? []).map(choice => choice.id));
  const raw = part.answer_hint?.mcq_correct_choice_id || '';
  const candidates =
    part.type === 'multi_choice' ? raw.split('') : raw ? [raw] : [];
  return [...new Set(candidates)].filter(id => available.has(id));
}

function storedPart(part: ExtractedPart, partCount: number) {
  const hint = part.answer_hint;
  const choiceIds = validChoiceIds(part);
  let correctAnswer = '';
  let answerConfig: Record<string, unknown> | null = null;

  if (
    part.type === 'single_choice' &&
    choiceIds.length === 1 &&
    (part.mcq_choices?.length ?? 0) >= 2
  ) {
    correctAnswer = choiceIds[0];
    answerConfig = {
      type: 'mcq',
      choices: part.mcq_choices,
      correct_choice_id: choiceIds[0],
      randomize_choices: true,
    };
  } else if (
    part.type === 'multi_choice' &&
    choiceIds.length > 0 &&
    (part.mcq_choices?.length ?? 0) >= 2
  ) {
    correctAnswer = choiceIds.join('');
    answerConfig = {
      type: 'multi_mcq',
      choices: part.mcq_choices,
      correct_choice_ids: choiceIds,
      randomize_choices: true,
    };
  } else if (
    (part.type === 'fill_blank' || part.type === 'short_answer') &&
    hint?.short_answer_value
  ) {
    correctAnswer = hint.short_answer_value;
    const numericValue = Number(hint.short_answer_value);
    answerConfig =
      hint.short_answer_is_numeric && Number.isFinite(numericValue)
        ? {
            type: 'short',
            mode: 'numeric',
            numeric_config: {
              correct_value: numericValue,
              tolerance: 0,
              unit: '',
            },
          }
        : {
            type: 'short',
            mode: 'text',
            acceptable_answers: [hint.short_answer_value],
          };
  } else if (part.type === 'essay' && hint?.extended_working) {
    correctAnswer = hint.extended_working;
  }

  return {
    index: part.index,
    type: part.type,
    ...(partCount > 1 && part.label?.trim()
      ? { label: part.label.trim() }
      : {}),
    ...(part.full_marks !== null &&
    part.full_marks !== undefined &&
    Number.isFinite(part.full_marks)
      ? { full_marks: Math.max(0, Math.round(part.full_marks)) }
      : {}),
    ...(correctAnswer ? { correct_answer: correctAnswer } : {}),
    ...(answerConfig ? { answer_config: answerConfig } : {}),
  };
}

function extractionContent(extraction: ParsedExtraction): string {
  const blocks: string[] = [];
  if (extraction.content.trim()) blocks.push(extraction.content.trim());
  for (const part of extraction.parts) {
    const label =
      extraction.parts.length > 1
        ? `${part.label?.trim() || `(${part.index})`} `
        : '';
    let text = `${label}${part.content.trim()}`.trim();
    // Choice options without a visible answer cannot be represented by the
    // current answer_config schema. Keep them in the rendered statement so
    // autonomous extraction never creates an unusable question.
    if (
      (part.type === 'single_choice' || part.type === 'multi_choice') &&
      validChoiceIds(part).length === 0 &&
      part.mcq_choices?.length
    ) {
      const choices = part.mcq_choices
        .map(choice => `${choice.id}. ${choice.text}`)
        .join('\n');
      text = `${text}\n${choices}`.trim();
    }
    if (text) blocks.push(text);
  }
  return convertMathTextToTipTapHtml(blocks.join('\n')).slice(0, 5000);
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

async function uploadSourceImages(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemId: string,
  images: ProblemExtractionImage[]
): Promise<ProblemAsset[]> {
  const uploaded: ProblemAsset[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const path = `user/${userId}/problems/${problemId}/problem/source-${index + 1}.${extensionForMime(image.mime_type)}`;
    const { error } = await supabase.storage
      .from(FILE_CONSTANTS.STORAGE.BUCKET)
      .upload(path, Buffer.from(image.data, 'base64'), {
        contentType: image.mime_type,
        cacheControl: FILE_CONSTANTS.STORAGE.CACHE_CONTROL,
        upsert: true,
      });
    if (error) {
      if (uploaded.length > 0) {
        await supabase.storage
          .from(FILE_CONSTANTS.STORAGE.BUCKET)
          .remove(uploaded.map(asset => asset.path));
      }
      throw new ProblemCreationServiceError(
        'image_upload_failed',
        error.message,
        503,
        true
      );
    }
    uploaded.push({ path, kind: 'image' });
  }
  return deriveProblemImageAssets(uploaded);
}

function assetPaths(assets: ProblemAsset[]): string[] {
  return [
    ...new Set(
      assets.flatMap(asset =>
        [asset.path, asset.display_path, asset.preview_path].filter(
          (path): path is string => Boolean(path)
        )
      )
    ),
  ];
}

async function cleanupUploadedAssets(
  supabase: SupabaseClient<Database>,
  assets: ProblemAsset[]
): Promise<void> {
  const paths = assetPaths(assets);
  if (paths.length === 0) return;
  await supabase.storage.from(FILE_CONSTANTS.STORAGE.BUCKET).remove(paths);
}

async function materializeTags(
  supabase: SupabaseClient<Database>,
  userId: string,
  subjectId: string,
  extraction: ProblemExtractionResult
): Promise<{
  tags: Array<{ id: string; name: string }>;
  warnings: string[];
}> {
  const tags = [...extraction.suggested_tags.existing];
  const suggestions = extraction.suggested_tags.new.slice(0, 5);
  const tagLimit =
    suggestions.length > 0
      ? await checkContentLimit(
          userId,
          CONTENT_LIMIT_CONSTANTS.RESOURCE_TYPES.TAGS_PER_SUBJECT,
          { subjectId }
        )
      : null;
  const creatable = suggestions.slice(0, tagLimit?.remaining ?? 0);
  const skipped = suggestions.slice(creatable.length);
  for (const suggestion of creatable) {
    const { data, error } = await supabase
      .from('tags')
      .upsert(
        {
          user_id: userId,
          subject_id: subjectId,
          name: suggestion.name,
        },
        {
          onConflict: 'user_id,subject_id,name',
        }
      )
      .select('id, name')
      .single();
    if (error) {
      throw new ProblemCreationServiceError(
        'tag_create_failed',
        error.message,
        500,
        true
      );
    }
    if (!tags.some(tag => tag.id === data.id)) tags.push(data);
  }
  return {
    tags,
    warnings:
      skipped.length > 0
        ? [
            `Skipped ${skipped.length} suggested tag(s) because this subject reached its tag limit`,
          ]
        : [],
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function ensureProblemCompletion(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemId: string,
  source: Record<string, unknown>
): Promise<void> {
  const tagIds = stringArray(source.mcp_tag_ids);
  if (tagIds.length > 0) {
    const { error } = await supabase.from('problem_tag').upsert(
      tagIds.map(tagId => ({
        user_id: userId,
        problem_id: problemId,
        tag_id: tagId,
      })),
      { onConflict: 'user_id,problem_id,tag_id' }
    );
    if (error) {
      throw new ProblemCreationServiceError(
        'problem_tag_link_failed',
        error.message,
        500,
        true
      );
    }
  }

  const problemSetId =
    typeof source.mcp_problem_set_id === 'string'
      ? source.mcp_problem_set_id
      : null;
  if (problemSetId) {
    const { data: existingLink, error: existingLinkError } = await supabase
      .from('problem_set_problems')
      .select('id')
      .eq('problem_set_id', problemSetId)
      .eq('problem_id', problemId)
      .maybeSingle();
    if (existingLinkError) {
      throw new ProblemCreationServiceError(
        'problem_set_link_failed',
        existingLinkError.message,
        500,
        true
      );
    }
    if (!existingLink) {
      const { error } = await supabase.from('problem_set_problems').insert({
        user_id: userId,
        problem_set_id: problemSetId,
        problem_id: problemId,
      });
      if (error) {
        throw new ProblemCreationServiceError(
          'problem_set_link_failed',
          error.message,
          500,
          true
        );
      }
    }
  }

  const { error: scheduleError } = await supabase
    .from('review_schedule')
    .upsert(
      {
        user_id: userId,
        problem_id: problemId,
        next_review_at: new Date().toISOString(),
        interval_days: 1,
      },
      { onConflict: 'user_id,problem_id' }
    );
  if (scheduleError) {
    throw new ProblemCreationServiceError(
      'review_schedule_create_failed',
      scheduleError.message,
      500,
      true
    );
  }
}

async function loadExistingProblem(
  supabase: SupabaseClient<Database>,
  userId: string,
  problemId: string,
  fingerprint: string
): Promise<CreatedProblemFromImages | null> {
  const { data, error } = await supabase
    .from('problems')
    .select(
      'id, subject_id, title, content, parts, status, assets, source, created_at'
    )
    .eq('id', problemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new ProblemCreationServiceError(
      'database_error',
      error.message,
      500,
      true
    );
  }
  if (!data) return null;
  const source =
    data.source &&
    typeof data.source === 'object' &&
    !Array.isArray(data.source)
      ? (data.source as Record<string, unknown>)
      : {};
  if (source.mcp_request_fingerprint !== fingerprint) {
    throw new ProblemCreationServiceError(
      'request_id_reused',
      'Request ID was already used with different problem input',
      409
    );
  }
  await ensureProblemCompletion(supabase, userId, problemId, source);
  const [
    { data: tagRows, error: tagReadError },
    { data: setRows, error: setReadError },
  ] = await Promise.all([
    supabase
      .from('problem_tag')
      .select('tags:tag_id(id, name)')
      .eq('user_id', userId)
      .eq('problem_id', problemId),
    supabase
      .from('problem_set_problems')
      .select('problem_set_id')
      .eq('problem_id', problemId)
      .limit(1),
  ]);
  if (tagReadError || setReadError) {
    throw new ProblemCreationServiceError(
      'database_error',
      tagReadError?.message ||
        setReadError?.message ||
        'Failed to reload problem relations',
      500,
      true
    );
  }
  return {
    problem: {
      id: data.id,
      subject_id: data.subject_id,
      title: data.title,
      content: data.content || '',
      parts: data.parts,
      status: data.status,
      assets: data.assets,
      tags: (tagRows || [])
        .map(row => row.tags)
        .flat()
        .filter((tag): tag is { id: string; name: string } =>
          Boolean(tag && typeof tag.id === 'string')
        ),
      created_at: data.created_at,
    },
    extraction: {
      suggest_image_asset: Boolean(source.suggest_image_asset),
      confidence: undefined,
      warnings: stringArray(source.mcp_creation_warnings),
    },
    problem_set_id: setRows?.[0]?.problem_set_id || null,
    replayed: true,
    quota: null,
  };
}

export async function createProblemFromImages(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: CreateProblemFromImagesInput
): Promise<CreatedProblemFromImages> {
  const problemId = deterministicProblemId(userId, input.request_id);
  const fingerprint = requestFingerprint(input);
  const replay = await loadExistingProblem(
    supabase,
    userId,
    problemId,
    fingerprint
  );
  if (replay) return replay;

  const resolved = await resolveSubject(
    supabase,
    userId,
    input.subject_id,
    input.problem_set_id
  );
  const problemLimit = await checkContentLimit(
    userId,
    CONTENT_LIMIT_CONSTANTS.RESOURCE_TYPES.PROBLEMS_PER_SUBJECT,
    { subjectId: resolved.subjectId }
  );
  if (!problemLimit.allowed) {
    throw new ProblemCreationServiceError(
      'problem_limit_reached',
      'Problem limit reached for this subject',
      403,
      false,
      problemLimit
    );
  }

  const extraction = await extractProblemFromImages(
    supabase,
    userId,
    input.images,
    resolved.subjectId
  );
  const shouldSaveImages =
    input.save_source_images ?? extraction.extraction.suggest_image_asset;
  if (
    extraction.extraction.suggest_image_asset &&
    input.save_source_images === false
  ) {
    throw new ProblemCreationServiceError(
      'image_asset_required',
      'The extracted problem depends on visual content, so source images must be saved',
      422
    );
  }
  if (shouldSaveImages) {
    const storageLimit = await checkContentLimit(
      userId,
      CONTENT_LIMIT_CONSTANTS.RESOURCE_TYPES.STORAGE_BYTES
    );
    if (!storageLimit.allowed) {
      throw new ProblemCreationServiceError(
        'storage_limit_reached',
        'Storage limit reached',
        403,
        false,
        storageLimit
      );
    }
  }

  const tagMaterialization = await materializeTags(
    supabase,
    userId,
    resolved.subjectId,
    extraction
  );
  const { tags } = tagMaterialization;
  const assets = shouldSaveImages
    ? await uploadSourceImages(supabase, userId, problemId, input.images)
    : [];
  const parts = extraction.extraction.parts.map(part =>
    storedPart(part, extraction.extraction.parts.length)
  ) as Json;
  const source = {
    actor: 'mcp',
    mcp_request_id: input.request_id,
    mcp_request_fingerprint: fingerprint,
    mcp_problem_set_id: resolved.problemSetId,
    mcp_tag_ids: tags.map(tag => tag.id),
    mcp_creation_warnings: tagMaterialization.warnings,
    suggest_image_asset: extraction.extraction.suggest_image_asset,
    extraction_confidence: extraction.extraction.confidence ?? null,
  } as Json;
  const { data: created, error } = await supabase
    .from('problems')
    .insert({
      id: problemId,
      user_id: userId,
      subject_id: resolved.subjectId,
      title: extraction.extraction.title,
      content: extractionContent(extraction.extraction),
      parts,
      source,
      is_optional: false,
      status: 'needs_review',
      assets: assets as Json,
      solution_text: '',
      solution_assets: [],
    })
    .select('id, subject_id, title, content, parts, status, assets, created_at')
    .single();
  if (error) {
    const concurrentReplay = await loadExistingProblem(
      supabase,
      userId,
      problemId,
      fingerprint
    );
    if (concurrentReplay) return concurrentReplay;
    await cleanupUploadedAssets(supabase, assets);
    throw new ProblemCreationServiceError(
      'problem_create_failed',
      error.message,
      500,
      true
    );
  }

  await ensureProblemCompletion(
    supabase,
    userId,
    problemId,
    source as Record<string, unknown>
  );
  await revalidateProblemComprehensive(problemId, resolved.subjectId, userId);

  return {
    problem: {
      ...created,
      content: created.content || '',
      tags,
    },
    extraction: {
      suggest_image_asset: extraction.extraction.suggest_image_asset,
      confidence: extraction.extraction.confidence,
      warnings: [
        ...(extraction.extraction.confidence?.warnings ?? []),
        ...tagMaterialization.warnings,
      ],
    },
    problem_set_id: resolved.problemSetId,
    replayed: false,
    quota: extraction.quota,
  };
}
