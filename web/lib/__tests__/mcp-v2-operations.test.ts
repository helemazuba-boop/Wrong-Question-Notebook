import { describe, it, expect, vi } from 'vitest';
import { callV2Tool, findV2Tool } from '@/lib/mcp/v2-tools';
import { fingerprint, OperationExecutor } from '@/lib/mcp/v2-operations';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
const { extract } = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock('@/lib/problem-extraction-service', async () => ({
  ...(await vi.importActual('@/lib/problem-extraction-service')),
  extractProblemFromImages: extract,
}));
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  oid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function harness(loseResponse = false) {
  let op: any = null;
  const row: any = {
    id: pid,
    user_id: uid,
    subject_id: pid,
    title: 'title',
    content: '',
    solution_text: '',
    parts: [],
    assets: [],
    solution_assets: [],
    revision: 1,
  };
  let commits = 0;
  const failures: string[] = [];
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === 'begin_mcp_operation_v2') {
      if (op) {
        if (op.fingerprint !== args.p_fingerprint)
          return { data: null, error: { message: 'request_id_reused' } };
        return { data: { ...op, claimed: false }, error: null };
      }
      op = {
        id: oid,
        user_id: uid,
        tool_name: args.p_tool_name,
        request_id: args.p_request_id,
        operation_kind: args.p_operation_kind,
        fingerprint: args.p_fingerprint,
        arguments: args.p_arguments,
        prepared: null,
        receipt: null,
        state: 'preparing',
        lease_token: pid,
        recover_until: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        resource_type: null,
        resource_id: null,
      };
      return { data: { ...op, claimed: true }, error: null };
    }
    if (name === 'prepare_mcp_operation_v2') {
      op = { ...op, prepared: args.p_prepared, state: 'prepared' };
      return { data: op, error: null };
    }
    if (name === 'commit_mcp_operation_v2') {
      commits++;
      if (op.prepared.kind === 'problem') {
        Object.assign(row, op.prepared);
        row.id = op.prepared.problem_id;
      }
      op = {
        ...op,
        state: 'committed',
        lease_token: null,
        resource_type: op.prepared.kind === 'problem' ? 'problem' : 'todo',
        resource_id: row.id,
        receipt: { kind: 'row', row: { ...row } },
      };
      if (loseResponse && commits === 1)
        return { data: null, error: { message: 'network response lost' } };
      return { data: op, error: null };
    }
    if (name === 'fail_mcp_operation_v2') {
      failures.push(args.p_code);
      return { data: null, error: null };
    }
    throw new Error(`Unexpected ${name}`);
  });
  const from = vi.fn((table: string) => {
    const b: any = {};
    for (const name of ['select', 'eq', 'is', 'limit', 'order'])
      b[name] = () => b;
    const value = () => ({
      data:
        table === 'mcp_v2_operations'
          ? op
          : table === 'mcp_v2_user_actions'
            ? []
            : table === 'problem_user_contexts'
              ? null
              : row,
      error: null,
    });
    b.maybeSingle = async () => value();
    b.single = async () => value();
    b.then = (resolve: any) => Promise.resolve(value()).then(resolve);
    return b;
  });
  const ctx = {
    userId: uid,
    apiTokenId: pid,
    credentialKind: 'oauth',
    origin: 'https://wqn.example',
    supabase: {
      rpc,
      from,
      storage: {
        from: () => ({
          createSignedUrls: async () => ({ data: [], error: null }),
          download: async () => ({
            data: new Blob(['image'], { type: 'image/png' }),
            error: null,
          }),
        }),
      },
    },
  } as unknown as McpToolContext;
  return { ctx, rpc, from, failures, commits: () => commits, op: () => op };
}
const args = {
  request_id: 'creation_req_0001',
  title: 'title',
  content: 'stem',
  parts: [
    {
      index: 1,
      type: 'multi_choice',
      content: 'part',
      label: null,
      full_marks: null,
      answer_hint: null,
      mcq_choices: [
        { id: 'A', text: 'first' },
        { id: 'B', text: 'second' },
      ],
    },
  ],
  suggest_image_asset: false,
  initial_idea_draft: 'my original idea',
};
describe('MCP v2 operation orchestration', () => {
  it('prepares complete printed structure and sends one atomic DB command', async () => {
    const h = harness();
    const result = await callV2Tool(h.ctx, 'create_problem', args);
    expect(result.status).toBe('completed');
    expect(
      findV2Tool('create_problem')!.resultSchema.safeParse(result).success
    ).toBe(true);
    expect(h.op().prepared.parts[0]).toMatchObject({
      content: '<p>part</p>',
      mcq_choices: args.parts[0].mcq_choices,
    });
    expect((result.data as any).item.parts[0].mcq_choices).toEqual(
      args.parts[0].mcq_choices
    );
    expect(h.op().arguments.initial_idea_draft).toBe('my original idea');
    expect(h.rpc.mock.calls[0][1].p_credential_kind).toBe('oauth');
    expect(h.commits()).toBe(1);
  });
  it('checks the durable receipt after a lost commit response without recording failure or resubmitting', async () => {
    const h = harness(true);
    const first = await callV2Tool(h.ctx, 'create_problem', args);
    expect(first.operation?.execution_state).toBe('committed');
    expect(first.status).toBe('completed');
    expect(h.failures).toEqual([]);
    const retry = await callV2Tool(h.ctx, 'create_problem', args);
    expect(retry.operation?.replayed).toBe(true);
    expect(h.commits()).toBe(1);
  });
  it('keeps owned original images and links the persisted extraction regions to the Problem', async () => {
    const h = harness();
    extract.mockResolvedValue({
      extraction: { ...args, new_tag_names: ['logic'] },
      ingestion: {
        id: pid,
        schema_version: 'problem-ingestion.v1',
        question_id: 'question-1',
        source_region_ids: ['stem-region'],
        visual_region_ids: ['figure-region'],
      },
    });
    const path = `user/${uid}/problems/original.png`;
    const result = await callV2Tool(h.ctx, 'create_problem_from_images', {
      request_id: 'image_creation_01',
      source_assets: [{ path, role: 'question' }],
    });
    expect(result.status).toBe('completed');
    expect(h.op().prepared.assets).toEqual([
      { path, role: 'question', kind: 'image' },
    ]);
    expect(h.op().prepared.source).toMatchObject({
      ingestion_id: pid,
      ingestion_question_id: 'question-1',
      source_region_ids: ['stem-region'],
      visual_region_ids: ['figure-region'],
    });
    expect(h.commits()).toBe(1);
  });
  it('will not replay changed initial idea under the same request id', async () => {
    const h = harness();
    await callV2Tool(h.ctx, 'create_problem', args);
    const result = await callV2Tool(h.ctx, 'create_problem', {
      ...args,
      initial_idea_draft: 'another',
    });
    expect(result.error?.code).toBe('request_id_reused');
    expect(h.commits()).toBe(1);
  });
  it('rejects unregistered business mutations in native preparation', () => {
    const h = harness();
    const op: any = { id: oid, lease_token: pid };
    const executor = new OperationExecutor(h.ctx, op);
    expect(() =>
      executor.client().from('problems').update({ title: 'bypass' })
    ).toThrow('未登记');
  });
  it('canonical input identity does not depend on JSON property order', () => {
    expect(fingerprint('create_problem', args)).toBe(
      fingerprint('create_problem', {
        initial_idea_draft: args.initial_idea_draft,
        ...args,
      })
    );
  });
});
