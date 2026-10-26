import { NextResponse } from 'next/server';
import { z } from 'zod';
import { markingEngine } from '@/lib/problem-marks/agent-contract';
import {
  AgentTaskSchema,
  agentRpc,
  authenticatedMarkService,
  loadAgentBundle,
  taskToken,
} from '@/lib/problem-marks/agent-service';
export const runtime = 'nodejs';
export const maxDuration = 30;
const Input = z.strictObject({
  action: z.enum([
    'claim',
    'renew',
    'bind',
    'prompt',
    'read',
    'fail',
    'telemetry',
    'health',
  ]),
  worker_id: z.string().min(1).max(100),
  run_id: z.uuid().optional(),
  session_id: z
    .string()
    .regex(/^ses_[A-Za-z0-9_-]+$/)
    .optional(),
  prompt_state: z.enum(['submitting', 'submitted']).optional(),
  error_code: z
    .string()
    .regex(/^[A-Z_]{1,100}$/)
    .optional(),
  telemetry: z.record(z.string(), z.json()).optional(),
});
export async function POST(req: Request) {
  if (!authenticatedMarkService(req))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const args = Input.safeParse(await req.json().catch(() => null));
  if (!args.success)
    return NextResponse.json(
      { error: 'INVALID_CONTROL_INPUT' },
      { status: 400 }
    );
  try {
    const engine = markingEngine();
    const { sha256, bundle, lock } = await loadAgentBundle();
    if (args.data.action === 'health') {
      const store = await agentRpc('health', {
        registry_source_sha: lock.source_sha,
        registry_content_sha256: lock.content_sha256,
      });
      if (!(
        store &&
        typeof store === 'object' &&
        !Array.isArray(store) &&
        store.ready === true
      ))
        throw new Error('REGISTRY_LOCK_MISMATCH');
      return NextResponse.json({
        data: {
          engine,
          bundle_sha256: sha256,
          skill_version: bundle.skill_version,
        },
      });
    }
    if (args.data.action !== 'claim' && !args.data.run_id)
      return NextResponse.json({ error: 'RUN_ID_REQUIRED' }, { status: 400 });
    const data = await agentRpc(args.data.action, {
      ...args.data,
      allow_new: engine === 'agent',
      bundle_sha256: sha256,
      skill_version: bundle.skill_version,
      registry_source_sha: lock.source_sha,
      registry_content_sha256: lock.content_sha256,
    });
    if (args.data.action === 'claim' && data) {
      const task = AgentTaskSchema.parse(data);
      return NextResponse.json({
        data: {
          ...task,
          context: undefined,
          task_token: taskToken(task.run_id),
        },
      });
    }
    // The internal runner is trusted; read includes durable state for recovery.
    return NextResponse.json({ data });
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'MARK_CONTROL_UNAVAILABLE';
    return NextResponse.json({ error: code }, { status: 503 });
  }
}
