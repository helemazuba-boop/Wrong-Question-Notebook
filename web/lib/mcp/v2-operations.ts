import 'server-only';
import { createHash } from 'crypto';
import type { McpToolContext } from './tool-registry';
import { MCP_LEASE_RENEW_MS, type McpV2Result } from './v2-contracts';

export type JsonObject = Record<string, any>;
export interface Operation extends JsonObject {
  id: string;
  user_id: string;
  tool_name: string;
  request_id: string;
  operation_kind: string;
  fingerprint: string;
  arguments: JsonObject;
  state: string;
  lease_token: string | null;
  prepared: JsonObject | null;
  receipt: JsonObject | null;
  resource_type: string | null;
  resource_id: string | null;
  recover_until: string;
  created_at: string;
  claimed?: boolean;
}
export class McpV2Error extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false
  ) {
    super(message);
  }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function fingerprint(tool: string, args: JsonObject) {
  return createHash('sha256')
    .update(canonicalJson({ contract: '2.0.0', tool, args }))
    .digest('hex');
}
export async function operationRpc(
  ctx: McpToolContext,
  name: string,
  args: JsonObject
) {
  const { data, error } = await (ctx.supabase as any).rpc(name, args);
  if (error) {
    const code = /^[a-z][a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'operation_unavailable';
    const retryable = [
      'operation_unavailable',
      'operation_lease_lost',
      'revision_conflict',
    ].includes(code);
    throw new McpV2Error(
      code,
      code === 'request_id_reused'
        ? '该 request_id 已用于不同输入；原操作未被重放。'
        : '操作状态暂不可用，请查询原 request_id。',
      retryable
    );
  }
  return data;
}
export async function loadOperation(
  ctx: McpToolContext,
  key: { id?: string; tool?: string; requestId?: string }
): Promise<Operation | null> {
  let query = (ctx.supabase as any)
    .from('mcp_v2_operations')
    .select('*')
    .eq('user_id', ctx.userId);
  query = key.id
    ? query.eq('id', key.id)
    : query.eq('tool_name', key.tool).eq('request_id', key.requestId);
  const { data, error } = await query.maybeSingle();
  if (error)
    throw new McpV2Error('operation_unavailable', '无法查询操作状态。', true);
  return data;
}
export async function beginOperation(
  ctx: McpToolContext,
  tool: string,
  args: JsonObject
): Promise<Operation> {
  return operationRpc(ctx, 'begin_mcp_operation_v2', {
    p_user_id: ctx.userId,
    p_tool_name: tool,
    p_operation_kind: tool.startsWith('create_problem')
      ? 'create_problem'
      : tool,
    p_request_id: args.request_id,
    p_fingerprint: fingerprint(tool, args),
    p_arguments: args,
    p_credential_kind: ctx.credentialKind,
    p_credential_id: ctx.apiTokenId,
  });
}
export function operationView(
  op: Operation,
  replayed: boolean
): McpV2Result['operation'] {
  return {
    operation_id: op.id,
    tool_name: op.tool_name,
    request_id: op.request_id,
    execution_state: op.state as NonNullable<
      McpV2Result['operation']
    >['execution_state'],
    replayed,
    recover_until: op.recover_until,
    created_at: op.created_at,
  };
}
export function operationUrl(ctx: McpToolContext, op: Operation) {
  return new URL(`/mcp/operations/${op.id}`, ctx.origin).toString();
}
export async function pendingActions(
  ctx: McpToolContext,
  op: Operation
): Promise<string[]> {
  const { data, error } = await (ctx.supabase as any)
    .from('mcp_v2_user_actions')
    .select('kind')
    .eq('user_id', ctx.userId)
    .eq('operation_id', op.id)
    .eq('state', 'pending');
  if (error)
    throw new McpV2Error('operation_unavailable', '待办状态暂不可用。', true);
  return (data ?? []).map((x: JsonObject) => x.kind);
}

/** Owns the execution lease and intercepts native business commands so the
 * existing engines and the durable receipt commit in the same SQL transaction. */
export class OperationExecutor {
  op: Operation;
  committing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    readonly ctx: McpToolContext,
    op: Operation,
    private readonly commitRpc = 'commit_mcp_operation_v2'
  ) {
    this.op = op;
  }
  startRenewal() {
    this.timer = setInterval(() => {
      void operationRpc(this.ctx, 'renew_mcp_operation_lease_v2', {
        p_user_id: this.ctx.userId,
        p_operation_id: this.op.id,
        p_lease_token: this.op.lease_token,
      }).catch(() => {
        /* Commit rechecks the lease in SQL. */
      });
    }, MCP_LEASE_RENEW_MS);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async prepare(command: JsonObject) {
    this.op = await operationRpc(this.ctx, 'prepare_mcp_operation_v2', {
      p_user_id: this.ctx.userId,
      p_operation_id: this.op.id,
      p_lease_token: this.op.lease_token,
      p_prepared: command,
    });
  }
  async commit(command?: JsonObject): Promise<JsonObject> {
    if (command) await this.prepare(command);
    this.committing = true;
    // An exception after this point is an unknown transport outcome. Never
    // persist "failed" from a client catch after a commit was attempted.
    this.op = await operationRpc(this.ctx, this.commitRpc, {
      p_user_id: this.ctx.userId,
      p_operation_id: this.op.id,
      p_lease_token: this.op.lease_token,
    });
    if (this.op.state !== 'committed')
      throw new McpV2Error(
        this.op.error?.code ?? 'database_error',
        this.op.error?.message ?? '事务未提交。',
        Boolean(this.op.error?.retryable)
      );
    return this.op.receipt!;
  }
  async fail(error: unknown) {
    if (this.committing) return;
    const e = error as { code?: string; retryable?: boolean };
    await operationRpc(this.ctx, 'fail_mcp_operation_v2', {
      p_user_id: this.ctx.userId,
      p_operation_id: this.op.id,
      p_lease_token: this.op.lease_token,
      p_code: e.code ?? 'preparation_failed',
      p_retryable: Boolean(e.retryable),
    });
  }
  client(): McpToolContext['supabase'] {
    const original = this.ctx.supabase as any;
    const native = new Set([
      'create_note_study_session_v1',
      'create_word_study_session_v1',
      'record_note_study_observation_v1',
      'skip_note_study_observation_v1',
      'record_study_observation_v1',
      'skip_study_observation_v1',
      'set_web_note_study_session_status_v1',
      'set_web_word_study_session_status_v1',
      'record_problem_review_v1',
    ]);
    const reads = new Set([
      'get_recent_note_reads_v2',
      'get_web_note_study_session_v2',
      'prune_word_packs_v1',
    ]);
    return new Proxy(original, {
      get: (target, key) => {
        if (key === 'rpc')
          return async (name: string, args: JsonObject) => {
            if (reads.has(name)) return original.rpc(name, args);
            if (!native.has(name))
              throw new McpV2Error('untracked_command', '未登记的写入命令。');
            const receipt = await this.commit({
              kind: 'rpc',
              function: name,
              args,
            });
            return { data: receipt.native_result, error: null };
          };
        if (key === 'from')
          return (table: string) =>
            new Proxy(original.from(table), {
              get: (builder, method) => {
                if (
                  ['insert', 'update', 'upsert', 'delete'].includes(
                    String(method)
                  )
                ) {
                  if (table === 'word_packs')
                    return builder[method].bind(builder); // preparation cache only
                  if (
                    method !== 'insert' ||
                    !['todos', 'notebook_notes', 'word_decks'].includes(table)
                  )
                    throw new McpV2Error(
                      'untracked_command',
                      '未登记的业务写入。'
                    );
                  return (row: JsonObject) => {
                    let columns = '*';
                    const deferred = {
                      select: (selection: string) => {
                        columns = selection;
                        return deferred;
                      },
                      single: async () => {
                        const receipt = await this.commit({
                          kind: 'insert',
                          table,
                          row,
                        });
                        return original
                          .from(table)
                          .select(columns)
                          .eq('id', receipt.row.id)
                          .single();
                      },
                    };
                    return deferred;
                  };
                }
                const value = builder[method];
                return typeof value === 'function'
                  ? value.bind(builder)
                  : value;
              },
            });
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as McpToolContext['supabase'];
  }
}
