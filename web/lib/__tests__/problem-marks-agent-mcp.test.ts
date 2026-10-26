import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  task: vi.fn(),
  bundle: vi.fn(),
  context: vi.fn(),
  submit: vi.fn(),
  images: vi.fn(),
}));
vi.mock('@/lib/problem-marks/agent-service', () => ({
  authenticatedMarkService: mocks.auth,
  authorizedAgentTask: mocks.task,
  loadAgentBundle: mocks.bundle,
  objectiveContext: mocks.context,
  submitAgentResult: mocks.submit,
  markImages: mocks.images,
}));
import { POST } from '@/app/api/mcp/mark/route';
const auth = {
  run_id: '11111111-1111-4111-8111-111111111111',
  task_token: 'a'.repeat(64),
};
const call = (method: string, params: unknown = {}) =>
  POST(
    new Request('http://wqn/api/mcp/mark', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue(true);
  mocks.task.mockResolvedValue({
    state: 'committed',
    receipt: { accepted: true },
    bundle_sha256: 'hash',
    registry_revision_id: 1,
  });
  mocks.bundle.mockResolvedValue({
    sha256: 'hash',
    bundle: { registry_content_sha256: 'hash' },
  });
  mocks.context.mockReturnValue({
    images: [{ id: 'image_0', asset: { path: 'private/path' } }],
    evidence_fields: { title: 'Question' },
  });
  mocks.images.mockResolvedValue([]);
});
describe('Dedicated marking MCP', () => {
  it('reports an uncertain database submission and directs the Agent to its original receipt', async () => {
    mocks.submit.mockRejectedValue(new Error('MARK_STORE_UNAVAILABLE'));
    const r = await (
      await call('tools/call', {
        name: 'submit_mark_result',
        arguments: {
          ...auth,
          result: {
            assignments: [],
            methods: [],
            unresolved: [
              {
                kind: 'knowledge',
                part_index: null,
                reason: 'registry_empty',
                detail: 'No registry entry.',
              },
            ],
          },
        },
      })
    ).json();
    expect(r.result.structuredContent.status).toBe('unknown');
    expect(r.result.structuredContent.next_actions[0].tool_name).toBe(
      'get_mark_receipt'
    );
  });
  it('requires its own service credential', async () => {
    mocks.auth.mockReturnValue(false);
    expect((await call('tools/list')).status).toBe(401);
    expect(mocks.task).not.toHaveBeenCalled();
  });
  it('advertises exactly the marking tools with structured contracts', async () => {
    const r = await (await call('tools/list')).json();
    expect(r.result.tools.map((x: { name: string }) => x.name)).toEqual([
      'get_mark_context',
      'read_mark_images',
      'submit_mark_result',
      'get_mark_receipt',
    ]);
    expect(
      r.result.tools.every((x: { outputSchema: unknown }) => x.outputSchema)
    ).toBe(true);
  });
  it('does not expose general user mutations', async () => {
    expect(
      (
        await (
          await call('tools/call', { name: 'create_problem', arguments: {} })
        ).json()
      ).error.code
    ).toBe(-32602);
  });
  it('rejects missing task credentials before loading a task', async () => {
    expect(
      (
        await (
          await call('tools/call', {
            name: 'get_mark_context',
            arguments: { run_id: auth.run_id },
          })
        ).json()
      ).error.code
    ).toBe(-32602);
    expect(mocks.task).not.toHaveBeenCalled();
  });
  it('returns canonical evidence fields and image ids without storage paths', async () => {
    const r = await (
      await call('tools/call', { name: 'get_mark_context', arguments: auth })
    ).json();
    expect(r.result.structuredContent.data.images).toEqual([{ id: 'image_0' }]);
    expect(r.result.structuredContent.data.result_schema).toBeDefined();
  });
  it('keeps a durable receipt readable after the task finished', async () => {
    const r = await (
      await call('tools/call', { name: 'get_mark_receipt', arguments: auth })
    ).json();
    expect(mocks.task).toHaveBeenCalledWith(
      auth.run_id,
      auth.task_token,
      false
    );
    expect(r.result.structuredContent.data.receipt.accepted).toBe(true);
  });
  it('returns a typed tool error rather than a false success', async () => {
    mocks.task.mockRejectedValue(new Error('TASK_NOT_AUTHORIZED'));
    const r = await (
      await call('tools/call', { name: 'get_mark_context', arguments: auth })
    ).json();
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent.error.code).toBe('TASK_NOT_AUTHORIZED');
  });
});
