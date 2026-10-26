import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase-utils';
import { FILE_CONSTANTS } from '@/lib/constants';
import { problemText } from '@/lib/mcp/v2-readers';
import { KnowledgeRegistryLockSchema } from './registry-artifact';
import {
  AgentBundleSchema,
  validateAgentEvidence,
  type AgentMarkResult,
} from './agent-contract';

const json = z.record(z.string(), z.unknown());
export const AgentTaskSchema = z
  .object({
    run_id: z.uuid(),
    problem_id: z.uuid(),
    semantic_revision: z.coerce.number(),
    registry_revision_id: z.coerce.number().nullable(),
    worker_id: z.string(),
    state: z.string(),
    lease_token: z.uuid(),
    lease_until: z.string(),
    deadline_at: z.string(),
    session_id: z.string().nullable(),
    prompt_state: z.string(),
    context: json,
    bundle_sha256: z.string(),
    skill_version: z.string(),
    receipt: json.nullable(),
    error_code: z.string().nullable(),
  })
  .passthrough();
export type AgentTask = z.infer<typeof AgentTaskSchema>;
let bundleCache: ReturnType<typeof loadBundle> | undefined;
async function loadBundle() {
  const [raw, rawLock] = await Promise.all([
    readFile(
      process.env.PROBLEM_MARKING_AGENT_BUNDLE_PATH ??
        path.join(process.cwd(), 'agent-marking.bundle.json')
    ),
    readFile(path.join(process.cwd(), 'knowledge-registry.lock.json'), 'utf8'),
  ]);
  const lock = KnowledgeRegistryLockSchema.parse(JSON.parse(rawLock));
  const bundle = AgentBundleSchema.parse(JSON.parse(raw.toString()));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (
    !lock.agent_marking ||
    lock.agent_marking.artifact_sha256 !== sha256 ||
    bundle.registry_content_sha256 !== lock.content_sha256 ||
    bundle.skill_version !== lock.agent_marking.skill_version
  )
    throw new Error('AGENT_BUNDLE_LOCK_MISMATCH');
  const active = bundle.registry.marks.filter(m => m.status === 'active');
  if (
    new Set(bundle.documents.map(d => d.stable_key)).size !== active.length ||
    active.some(
      m =>
        !bundle.documents.some(
          d =>
            d.stable_key === m.stable_key &&
            d.subject === m.subject &&
            d.kind === m.kind
        )
    )
  )
    throw new Error('INVALID_AGENT_BUNDLE');
  return { bundle, sha256, lock };
}
export function loadAgentBundle() {
  bundleCache ??= loadBundle().catch(error => {
    bundleCache = undefined;
    throw error;
  });
  return bundleCache;
}
export function agentSecret(): string {
  const secret = process.env.PROBLEM_MARKING_AGENT_SECRET ?? '';
  if (secret.length < 32) throw new Error('AGENT_SECRET_NOT_CONFIGURED');
  return secret;
}
export function authenticatedMarkService(req: Request): boolean {
  try {
    const actual = Buffer.from(req.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${agentSecret()}`);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
export function taskToken(runId: string): string {
  return createHmac('sha256', agentSecret())
    .update(`wqn:mark:1:${runId}`)
    .digest('hex');
}
export async function agentRpc(
  action: string,
  payload: Record<string, unknown> = {}
) {
  const request = createServiceClient().rpc('agent_mark_control_v1', {
    p_action: action,
    p_payload: payload as never,
  });
  const { data, error } = await Promise.resolve(request).catch(() => {
    throw new Error('MARK_STORE_UNAVAILABLE');
  });
  if (error)
    throw new Error(
      /^[A-Z_]+$/.test(error.message) ? error.message : 'MARK_STORE_UNAVAILABLE'
    );
  return data;
}
export async function authorizedAgentTask(
  runId: string,
  token: string,
  active = true
): Promise<AgentTask> {
  const expected = Buffer.from(taskToken(runId));
  const supplied = Buffer.from(token);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new Error('TASK_NOT_AUTHORIZED');
  const task = AgentTaskSchema.parse(await agentRpc('read', { run_id: runId }));
  if (
    active &&
    (task.state !== 'processing' || Date.parse(task.deadline_at) <= Date.now())
  )
    throw new Error('TASK_NOT_ACTIVE');
  return task;
}
export function objectiveContext(task: AgentTask) {
  const c = task.context;
  const fields: Record<string, string> = {
    title: String(c.title ?? ''),
    content: problemText(String(c.content ?? '')),
    solution_text: problemText(String(c.solution_text ?? '')),
  };
  const parts = (Array.isArray(c.parts) ? c.parts : []).map(part => {
    const p = part as Record<string, unknown>;
    const index = Number(p.index);
    const content = problemText(String(p.content ?? ''));
    fields[`parts.${index}.content`] = content;
    const choices = (p.answer_config as { choices?: unknown } | undefined)
      ?.choices;
    if (Array.isArray(choices))
      for (const choice of choices) {
        const v = choice as { id?: string; text?: string };
        if (v.id && v.text)
          fields[`parts.${index}.choices.${v.id}`] = problemText(v.text);
      }
    return { index, type: p.type, content, choices: choices ?? [] };
  });
  const assets = [
    ...(Array.isArray(c.assets) ? c.assets : []),
    ...(Array.isArray(c.solution_assets) ? c.solution_assets : []),
  ].filter(
    asset =>
      asset &&
      typeof asset === 'object' &&
      !['student_work', 'working', 'annotation', 'teacher_mark'].includes(
        String((asset as { role?: string }).role)
      )
  );
  return {
    problem_id: task.problem_id,
    semantic_revision: task.semantic_revision,
    subject_key: typeof c.subject_key === 'string' ? c.subject_key : null,
    title: fields.title,
    content: fields.content,
    solution_text: fields.solution_text,
    parts,
    part_indexes: parts.map(p => p.index),
    evidence_fields: fields,
    images: assets.map((asset, i) => ({ id: `image_${i}`, asset })),
    bundle_sha256: task.bundle_sha256,
    skill_version: task.skill_version,
    deadline_at: task.deadline_at,
  };
}
export async function submitAgentResult(
  task: AgentTask,
  result: AgentMarkResult
) {
  const { bundle, sha256 } = await loadAgentBundle();
  if (sha256 !== task.bundle_sha256) throw new Error('AGENT_BUNDLE_CHANGED');
  validateAgentEvidence(result, objectiveContext(task), bundle);
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  return agentRpc('submit', {
    run_id: task.run_id,
    result,
    objective_snapshot_hash: createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(
            [
              'title',
              'content',
              'parts',
              'solution_text',
              'assets',
              'solution_assets',
            ].map(key => [key, task.context[key]])
          )
        )
      )
      .digest('hex'),
    fingerprint: createHash('sha256').update(canonical(result)).digest('hex'),
  });
}
export async function markImages(task: AgentTask, ids: string[]) {
  const images = objectiveContext(task).images;
  const blocks = [];
  for (const id of ids) {
    const entry = images.find(image => image.id === id);
    if (!entry) throw new Error('IMAGE_NOT_IN_TASK');
    const a = entry.asset as { display_path?: string; path?: string };
    const { data, error } = await createServiceClient()
      .storage.from(FILE_CONSTANTS.STORAGE.BUCKET)
      .download(a.display_path ?? a.path ?? '');
    if (
      error ||
      !data ||
      data.size > 5 * 1024 * 1024 ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
        data.type
      )
    )
      throw new Error('IMAGE_UNAVAILABLE');
    blocks.push({
      type: 'image' as const,
      data: Buffer.from(await data.arrayBuffer()).toString('base64'),
      mimeType: data.type,
    });
  }
  return blocks;
}
