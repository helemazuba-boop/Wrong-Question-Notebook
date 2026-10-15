import 'server-only';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { FILE_CONSTANTS } from '@/lib/constants';
import { storedPart } from '@/lib/problem-creation-service';
import {
  extractProblemFromImages,
  type ProblemExtractionResult,
} from '@/lib/problem-extraction-service';
import { sanitizeHtmlContent } from '@/lib/html-sanitizer';
import { convertMathTextToTipTapHtml } from '@/lib/math-to-tiptap';
import { AnswerConfigSchema, ProblemPartsSchema } from '@/lib/schemas';
import {
  createNoteStudySession,
  recordNoteStudyObservation,
  skipNoteStudyObservation,
} from '@/lib/note-study-service';
import {
  createWordStudySession,
  recordWordStudyObservation,
  skipWordStudyObservation,
} from '@/lib/word-study-service';
import { findMcpTool, MCP_TOOLS, type McpToolContext } from './tool-registry';
import {
  buildV2Tools,
  CreateProblemArgs,
  DIRECT_WRITE_TOOLS,
  EDIT_TOOLS,
  MCP_V2_INSTRUCTIONS,
  MCP_V2_VERSION,
  ProposalSchemas,
  type McpV2Result,
  type McpV2ToolName,
} from './v2-contracts';
import {
  beginOperation,
  loadOperation,
  operationRpc,
  operationUrl,
  operationView,
  pendingActions,
  OperationExecutor,
  McpV2Error,
  type JsonObject,
  type Operation,
} from './v2-operations';
import {
  legacyArgs,
  problemDetail,
  readV2,
  requirePermission,
  resource,
  session,
} from './v2-readers';

export const MCP_V2_TOOLS = buildV2Tools(
  Object.fromEntries(MCP_TOOLS.map(t => [t.name, t.description]))
);
export const findV2Tool = (name: string) =>
  MCP_V2_TOOLS.find(t => t.name === name);
export const CREATION_PROMPT = `识别一条已经选定的原题，输出 get_problem_creation_spec 中的 create_problem JSON。保留题干、每一小题与独立选项；不解题。answer_hint 仅填清晰可见的印刷官方答案，缺失时为 null；非选择题 mcq_choices 为 []。未知 label/full_marks 为 null。tags 仅用于知识点。缺失图表时 suggest_image_asset=true，创建普通题目后让用户在 WQN 补图。学生想法只放 initial_idea_draft，用户确认前不能声称是本人证据。AI 解答应在创建后通过 submit_problem_update 提案并由用户审核。request_id 重试必须完全复用，不能删改输入后重用。`;
const workflows = [
  {
    task: '浏览错题本并复习',
    tools: [
      'list_problem_sets',
      'list_problem_set_problems',
      'get_problem_detail',
      'record_problem_review',
    ],
    steps: [
      '分页查看错题集，智能集按筛选条件返回。',
      '读完整题目再分析，复习自评带 request_id。',
    ],
    limitations: ['没有正式作答或独立错因分类实体。'],
  },
  {
    task: '采集题目、补图、分析并修改',
    tools: [
      'get_problem_creation_spec',
      'create_problem',
      'create_problem_from_images',
      'submit_problem_update',
    ],
    steps: [
      '保存普通题目，印刷答案与学生想法分开。',
      '让用户在 WQN 上传图片或确认原始想法。',
      'AI 答案与解析作为修改提案，用户审核差异后生效。',
    ],
    limitations: ['MCP 不上传原图，不批准修改，不擅自把分析转存 Note。'],
  },
  {
    task: '笔记与词汇学习',
    tools: [
      'list_authorized_notebooks',
      'list_authorized_word_decks',
      'start_note_reading_session',
      'start_word_study_session',
    ],
    steps: [
      '先查看当前授权，只读取或新增已授权的内容。',
      '会话返回当前项；完成或跳过一次推进一个 sequence。',
      '已有内容的任何修改均返回 WQN 审批链接。',
    ],
    limitations: ['新建词库不会自动授权 AI；没有删除或回滚工具。'],
  },
  {
    task: 'Todo 与恢复',
    tools: [
      'list_todos',
      'create_todo',
      'update_todo',
      'update_todo_status',
      'get_operation_status',
      'resume_operation',
    ],
    steps: [
      '内容修改经 WQN 审批；完成或取消是直接幂等动作。',
      '超时查回执；未提交操作 24 小时内自动恢复。',
      '已提交回执长期重放；等待用户的操作仅返回入口。',
    ],
    limitations: ['resume 不能修改原参数、绕过审批或恢复已删除资源。'],
  },
];
const empty = (
  status: McpV2Result['status'],
  data: unknown = null
): McpV2Result => ({
  status,
  data,
  error: null,
  operation: null,
  next_actions: [],
  warnings: [],
});
export function failure(error: unknown): McpV2Result {
  const e = error as { code?: string; message?: string; retryable?: boolean };
  return {
    ...empty('failed'),
    error: {
      code: e.code ?? 'tool_execution_failed',
      message: e instanceof McpV2Error ? e.message : '工具执行失败。',
      retryable: Boolean(e.retryable),
    },
  };
}
export function problemId(userId: string, requestId: string) {
  // Retain the v1 deterministic id to detect, never misreport, legacy partial writes.
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`wqn:mcp:create-problem:${userId}:${requestId}`)
      .digest()
      .subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const html = (text: string) =>
  sanitizeHtmlContent(convertMathTextToTipTapHtml(text));
function normalizeChanges(kind: string, changes: JsonObject) {
  const result = { ...changes };
  if (kind === 'problem') {
    if ('content' in result) result.content = html(result.content);
    if (result.solution_text != null)
      result.solution_text = html(result.solution_text);
    if (result.parts) {
      const normalized = result.parts.map((p: JsonObject) => {
        const value: JsonObject = { ...p, content: html(p.content) };
        for (const key of ['label', 'full_marks', 'correct_answer'])
          if (value[key] === null) delete value[key];
        if (
          value.answer_config != null &&
          !AnswerConfigSchema.safeParse(value.answer_config).success
        )
          throw new McpV2Error(
            'invalid_answer_config',
            '答案配置不符合判题结构。'
          );
        if (
          !value.answer_config &&
          value.mcq_choices?.length &&
          value.correct_answer &&
          ['single_choice', 'multi_choice'].includes(value.type)
        ) {
          const answer = storedPart(
            {
              ...value,
              answer_hint: { mcq_correct_choice_id: value.correct_answer },
            } as any,
            result.parts.length
          );
          if (!answer.answer_config)
            throw new McpV2Error(
              'invalid_answer_config',
              '正确选项必须属于题目的选项列表。'
            );
          value.answer_config = answer.answer_config;
        }
        return value;
      });
      const parsed = ProblemPartsSchema.safeParse(normalized);
      if (!parsed.success)
        throw new McpV2Error(
          'invalid_parts',
          '小题结构、连续序号或答案配置无效。'
        );
      result.parts = parsed.data;
    }
  }
  // Note content is plain/markdown text, matching Web, never HTML-executed here.
  return result;
}
async function prepareProblem(
  ctx: McpToolContext,
  args: JsonObject,
  fromImages: boolean
) {
  let draft = args;
  let ingestion: ProblemExtractionResult['ingestion'];
  const assets: JsonObject[] = [];
  if (fromImages) {
    const images = [];
    for (const asset of args.source_assets) {
      if (
        !asset.path.startsWith(`user/${ctx.userId}/`) ||
        asset.path.includes('..') ||
        asset.path.includes('\\')
      )
        throw new McpV2Error(
          'asset_not_owned',
          '图片必须来自用户在 WQN 上传的文件。'
        );
      const { data, error } = await ctx.supabase.storage
        .from(FILE_CONSTANTS.STORAGE.BUCKET)
        .download(asset.path);
      if (error || !data)
        throw new McpV2Error('asset_unavailable', '原图不可用。', true);
      if (data.size > FILE_CONSTANTS.MAX_FILE_SIZE.GENERAL)
        throw new McpV2Error(
          'image_too_large',
          '原图超过 Web 单文件大小限制。'
        );
      const mime = z
        .enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
        .safeParse(data.type);
      if (!mime.success)
        throw new McpV2Error(
          'invalid_image_type',
          '原图格式不受识别服务支持。'
        );
      images.push({
        data: Buffer.from(await data.arrayBuffer()).toString('base64'),
        mime_type: mime.data,
      });
      assets.push({ ...asset, kind: 'image' });
    }
    const extracted = await extractProblemFromImages(
      ctx.supabase,
      ctx.userId,
      images,
      args.subject_id
    );
    ingestion = extracted.ingestion;
    draft = {
      ...extracted.extraction,
      ...args,
      tags: extracted.extraction.new_tag_names,
    };
  }
  if (!draft.parts.every((p: JsonObject, i: number) => p.index === i + 1))
    throw new McpV2Error('invalid_part_indexes', '小题序号必须从 1 连续递增。');
  for (const p of draft.parts) {
    const ids = (p.mcq_choices ?? []).map((c: JsonObject) => c.id);
    if (
      new Set(ids).size !== ids.length ||
      (!['single_choice', 'multi_choice'].includes(p.type) && ids.length)
    )
      throw new McpV2Error(
        'invalid_choices',
        '选项编号必须唯一，非选择题选项应为空数组。'
      );
    const stored = storedPart(p as any, draft.parts.length);
    if (
      p.answer_hint &&
      (p.answer_hint.mcq_correct_choice_id ||
        p.answer_hint.short_answer_value ||
        p.answer_hint.extended_working) &&
      !stored.correct_answer
    )
      throw new McpV2Error(
        'invalid_answer_hint',
        '给出的印刷答案不符合小题类型或选项结构，请核对后使用新的 request_id。'
      );
  }
  let subjectId = args.subject_id ?? null;
  if (args.problem_set_id) {
    const { data, error } = await ctx.supabase
      .from('problem_sets')
      .select('subject_id,is_smart')
      .eq('id', args.problem_set_id)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (error || !data || data.is_smart)
      throw new McpV2Error(
        'invalid_problem_set',
        '请选择本人拥有的手动错题集。'
      );
    if (subjectId && subjectId !== data.subject_id)
      throw new McpV2Error('subject_mismatch', '题目与错题集的科目不同。');
    subjectId = data.subject_id;
  }
  const parts = ProblemPartsSchema.safeParse(
    draft.parts.map((p: any) => ({
      ...storedPart(p, draft.parts.length),
      content: html(p.content),
      mcq_choices: p.mcq_choices ?? [],
    }))
  );
  if (!parts.success)
    throw new McpV2Error(
      'invalid_parts',
      '识别的小题超出 WQN 内容、选项或分值限制。'
    );
  const content = html(draft.content),
    solution = args.solution_text ? html(args.solution_text) : '';
  if (content.length > 5000 || solution.length > 5000)
    throw new McpV2Error(
      'content_too_long',
      '转换后的题目或解析超过 WQN 内容长度限制。'
    );
  return {
    kind: 'problem',
    problem_id: problemId(ctx.userId, args.request_id),
    title: draft.title,
    content,
    parts: parts.data,
    subject_id: subjectId,
    problem_set_id: args.problem_set_id ?? null,
    tags: [...new Set(draft.tags ?? [])],
    solution_text: solution,
    assets,
    needs_images: Boolean(draft.suggest_image_asset) && assets.length === 0,
    source: {
      source_kind: fromImages ? 'images' : 'structured',
      answer_origin: 'printed_official',
      ...(args.solution_text ? { solution_origin: 'ai_supplied' } : {}),
      confidence: draft.confidence ?? null,
      ...(ingestion
        ? {
            ingestion_id: ingestion.id,
            ingestion_schema_version: ingestion.schema_version,
            ingestion_question_id: ingestion.question_id,
            source_region_ids: ingestion.source_region_ids,
            visual_region_ids: ingestion.visual_region_ids,
          }
        : {}),
    },
  };
}
async function guardOperation(ctx: McpToolContext, op: Operation) {
  const args = op.arguments;
  if (
    op.tool_name === 'create_notebook_note' ||
    op.tool_name === 'update_notebook_note'
  )
    await requirePermission(
      ctx,
      'note',
      [args.notebook_id],
      op.tool_name === 'create_notebook_note'
    );
  if (op.tool_name === 'add_word_entry')
    await requirePermission(ctx, 'word', [args.word_deck_id], true);
  if (op.tool_name === 'update_word_entry')
    await readV2(ctx, 'get_word_detail', { word_entry_id: args.word_entry_id });
  if (
    op.tool_name.includes('session') ||
    op.tool_name.includes('reading_observation') ||
    op.tool_name.includes('study_observation')
  ) {
    const kind = op.tool_name.includes('note') ? 'note' : 'word';
    if (args.session_id) await session(ctx, kind, args.session_id);
    else
      await requirePermission(
        ctx,
        kind,
        kind === 'note' ? args.notebook_ids : args.word_deck_ids
      );
  }
}
async function materialize(
  ctx: McpToolContext,
  op: Operation
): Promise<unknown> {
  if (EDIT_TOOLS[op.tool_name as McpV2ToolName])
    return {
      proposal_id: op.id,
      resource_type: op.resource_type,
      resource_id: op.resource_id,
      expected_revision: op.expected_revision,
      changes: op.arguments.changes,
    };
  if (
    op.resource_type === 'problem' &&
    op.tool_name.startsWith('create_problem')
  )
    return problemDetail(ctx, op.resource_id!);
  if (op.resource_type?.endsWith('_session')) {
    const data = await session(
      ctx,
      op.resource_type.startsWith('note') ? 'note' : 'word',
      op.resource_id!
    );
    return op.tool_name.startsWith('record_')
      ? { observation: op.receipt?.native_result, ...data }
      : data;
  }
  if (op.tool_name === 'record_problem_review')
    return { observation: op.receipt?.native_result };
  const row = op.receipt?.row;
  if (row) return { item: resource(row, op.resource_type!) };
  return null;
}
async function operationResult(
  ctx: McpToolContext,
  op: Operation,
  replayed: boolean,
  control = false
): Promise<McpV2Result> {
  await guardOperation(ctx, op);
  const actions = await pendingActions(ctx, op);
  const result = empty(
    op.state === 'committed'
      ? actions.length
        ? 'requires_user_action'
        : 'completed'
      : op.state === 'awaiting_approval'
        ? 'requires_user_action'
        : op.state === 'failed' || op.state === 'rejected'
          ? 'failed'
          : 'in_progress'
  );
  result.operation = operationView(op, replayed);
  if (op.state === 'committed' || op.state === 'awaiting_approval') {
    const data = await materialize(ctx, op);
    if (op.tool_name.startsWith('record_') && (data as JsonObject)?.observation)
      (data as JsonObject).observation.replayed = replayed;
    if (
      op.resource_type === 'problem' &&
      op.tool_name.startsWith('create_problem') &&
      (data as JsonObject)?.item
    )
      (data as JsonObject).item.image_upload_url = operationUrl(ctx, op);
    result.data = control
      ? {
          operation_id: op.id,
          tool_name: op.tool_name,
          execution_state: op.state,
          resource_type: op.resource_type,
          resource_id: op.resource_id,
          pending_actions: actions,
          result: EDIT_TOOLS[op.tool_name as McpV2ToolName]
            ? { proposal_id: op.id }
            : (data as JsonObject)?.item
              ? data
              : op.resource_type?.endsWith('_session')
                ? { session_id: op.resource_id }
                : null,
        }
      : data;
  } else if (control)
    result.data = {
      operation_id: op.id,
      tool_name: op.tool_name,
      execution_state: op.state,
      resource_type: op.resource_type,
      resource_id: op.resource_id,
      pending_actions: actions,
      result: null,
    };
  if (result.status === 'requires_user_action')
    result.next_actions = [
      {
        kind: 'open_wqn',
        url: operationUrl(ctx, op),
        description:
          op.state === 'awaiting_approval'
            ? '用户登录 WQN 查看差异并批准或拒绝本次修改。'
            : `用户在 WQN 完成：${actions.join('、')}。`,
      },
    ];
  if (result.status === 'in_progress')
    result.next_actions = [
      {
        kind: 'call_tool',
        tool_name: 'get_operation_status',
        arguments: { tool_name: op.tool_name, request_id: op.request_id },
        description: '等待正在执行的原操作；查询回执。',
      },
    ];
  if (op.state === 'failed' || op.state === 'rejected')
    result.error = op.error ?? {
      code: 'proposal_rejected',
      message: '用户已拒绝本次提案。',
      retryable: false,
    };
  if (
    (op.resume_expired || Date.parse(op.recover_until) <= Date.now()) &&
    ['preparing', 'prepared', 'failed'].includes(op.state)
  ) {
    result.status = 'failed';
    result.error = {
      code: 'resume_expired',
      message: '24 小时自动恢复窗口已结束；先查看状态，不重建已提交内容。',
      retryable: false,
    };
  }
  if (op.error?.code === 'legacy_unverified') {
    result.operation!.execution_state = 'legacy_unverified';
    result.warnings.push('检测到旧版记录，尚未证明全流程完成；需要只读核对。');
  }
  return result;
}

async function executeWrite(
  ctx: McpToolContext,
  name: McpV2ToolName,
  args: JsonObject,
  control = false
): Promise<McpV2Result> {
  const op = await beginOperation(ctx, name, args);
  if (!op.claimed) return operationResult(ctx, op, true, control);
  const executor = new OperationExecutor(ctx, op);
  executor.startRenewal();
  try {
    await guardOperation(ctx, op);
    const edit = EDIT_TOOLS[name];
    if (edit) {
      if (Object.keys(args.changes).length === 0)
        throw new McpV2Error(
          'empty_changes',
          'changes 至少包含一个可编辑字段。'
        );
      if (
        edit === 'problem' &&
        'initial_idea' in args.changes &&
        args.expected_initial_idea_revision === undefined
      )
        throw new McpV2Error(
          'idea_revision_required',
          '编辑个人思路时必须提供读取到的 expected_initial_idea_revision。'
        );
      const id =
        args.problem_id ?? args.note_id ?? args.word_entry_id ?? args.todo_id;
      if (edit === 'note')
        await readV2(ctx, 'get_note', {
          notebook_id: args.notebook_id,
          note_id: id,
        });
      const changes = normalizeChanges(
        edit,
        ProposalSchemas[edit].parse(args.changes)
      );
      executor.op = await operationRpc(ctx, 'propose_mcp_update_v2', {
        p_user_id: ctx.userId,
        p_operation_id: op.id,
        p_lease_token: op.lease_token,
        p_resource_type: edit,
        p_resource_id: id,
        p_changes: changes,
        p_expected_revision: args.expected_revision,
        p_expected_idea_revision: args.expected_initial_idea_revision ?? null,
      });
    } else if (op.prepared) await executor.commit();
    else if (name === 'create_problem' || name === 'create_problem_from_images')
      await executor.commit(
        await prepareProblem(ctx, args, name === 'create_problem_from_images')
      );
    else if (name === 'add_word_entry') {
      const { request_id: ignored, word_deck_id: deck, ...fields } = args;
      void ignored;
      await executor.commit({
        kind: 'insert',
        table: 'word_entries',
        row: {
          ...fields,
          id: randomUUID(),
          deck_id: deck,
          word: fields.word.trim(),
          normalized_word: fields.word.trim().toLocaleLowerCase('en-US'),
          meaning: fields.meaning.trim(),
          tags: fields.tags ?? [],
          metadata: { source: 'mcp', operation_id: op.id },
        },
      });
    } else if (name === 'update_todo_status')
      await executor.commit({ kind: 'todo_status' });
    else {
      const client = executor.client(),
        callCtx = { ...ctx, supabase: client };
      const meta = {
        request_id: args.request_id,
        boot_id: 'mcp-stateless',
        firmware_version: 'mcp-2.0.0',
        capabilities: ['study.mcp.v2'],
      };
      if (name === 'start_note_reading_session')
        await createNoteStudySession(client, ctx.userId, null, {
          ...meta,
          domain: 'note',
          mode: args.mode,
          scope: { notebook_ids: args.notebook_ids, include_archived: false },
          optional_count: args.optional_count,
          seed: args.seed,
        });
      else if (name === 'start_word_study_session')
        await createWordStudySession(client, ctx.userId, null, {
          ...meta,
          domain: 'word',
          mode: args.mode,
          scope: {
            deck_ids: args.word_deck_ids,
            include_mastered: Boolean(args.include_mastered),
          },
          optional_count: args.optional_count ?? 50,
          seed: args.seed,
        });
      else if (
        name === 'record_note_reading_observation' ||
        name === 'record_word_study_observation'
      ) {
        const kind = name.includes('note') ? 'note' : 'word';
        const view = await session(ctx, kind, args.session_id);
        const request = {
          ...meta,
          session_id: args.session_id,
          sequence: args.sequence,
          item_id: args.note_id ?? args.word_entry_id,
          action: args.action,
          mode: view.session.mode,
          occurred_at: args.occurred_at ?? new Date().toISOString(),
        };
        // Native RPC checks its idempotency receipt before checking sequence/revision.
        if (kind === 'note')
          await (
            args.action === 'skipped'
              ? skipNoteStudyObservation
              : recordNoteStudyObservation
          )(client, ctx.userId, null, request);
        else
          await (
            args.action === 'skipped'
              ? skipWordStudyObservation
              : recordWordStudyObservation
          )(client, ctx.userId, null, request);
      } else if (
        name === 'set_note_reading_session_status' ||
        name === 'set_word_study_session_status'
      ) {
        await (client as any).rpc(
          name.includes('note')
            ? 'set_web_note_study_session_status_v1'
            : 'set_web_word_study_session_status_v1',
          {
            p_user_id: ctx.userId,
            p_session_id: args.session_id,
            p_status: args.status,
          }
        );
      } else
        await findMcpTool(name)!.handler(callCtx, {
          ...legacyArgs(args),
          ...(name === 'create_notebook_note'
            ? { client_request_id: args.request_id }
            : {}),
        });
      if (executor.op.state !== 'committed')
        throw new McpV2Error(
          'missing_atomic_command',
          '没有提交受登记的业务命令。'
        );
    }
    return operationResult(ctx, executor.op, false, control);
  } catch (error) {
    try {
      await executor.fail(error);
    } catch {
      /* Unavailable status remains unknown. */
    }
    let latest: Operation | null = null;
    try {
      latest = await loadOperation(ctx, { id: op.id });
    } catch {
      /* see below */
    }
    if (
      latest?.state === 'committed' ||
      latest?.state === 'awaiting_approval'
    ) {
      try {
        return await operationResult(ctx, latest, true, control);
      } catch {
        /* Committed but readback failed: preserve uncertainty in result. */
      }
    }
    if (latest?.state === 'failed')
      return operationResult(ctx, latest, false, control);
    const result = empty(executor.committing ? 'unknown' : 'failed');
    result.operation = operationView(latest ?? op, false);
    result.error = failure(error).error;
    result.next_actions = [
      {
        kind: 'call_tool',
        tool_name: 'get_operation_status',
        arguments: { tool_name: name, request_id: args.request_id },
        description: '查询原操作，保持同一 request_id 与输入。',
      },
    ];
    return result;
  } finally {
    executor.stop();
  }
}
export async function callV2Tool(
  ctx: McpToolContext,
  name: McpV2ToolName,
  args: JsonObject
): Promise<McpV2Result> {
  try {
    if (name === 'get_workflow_guide')
      return empty('completed', {
        contract_version: MCP_V2_VERSION,
        instructions: MCP_V2_INSTRUCTIONS,
        workflows,
      });
    if (name === 'get_problem_creation_spec')
      return empty('completed', {
        contract_version: MCP_V2_VERSION,
        prompt: CREATION_PROMPT,
        input_schema: z.toJSONSchema(CreateProblemArgs, {
          target: 'draft-2020-12',
        }),
        examples: [
          {
            request_id: 'example_problem_01',
            title: '示例题',
            content: '',
            parts: [
              {
                index: 1,
                label: null,
                type: 'short_answer',
                content: '请填写原题题面。',
                full_marks: null,
                mcq_choices: [],
                answer_hint: null,
              },
            ],
            suggest_image_asset: false,
          },
        ],
      });
    if (name === 'get_operation_status' || name === 'resume_operation') {
      const op = await loadOperation(
        ctx,
        name === 'resume_operation'
          ? { id: args.operation_id }
          : { tool: args.tool_name, requestId: args.request_id }
      );
      if (!op)
        throw new McpV2Error(
          'operation_not_found',
          '未找到该操作；没有证明任何写入已提交。'
        );
      if (
        name === 'resume_operation' &&
        !['committed', 'awaiting_approval', 'rejected'].includes(op.state)
      )
        return await executeWrite(
          ctx,
          op.tool_name as McpV2ToolName,
          op.arguments,
          true
        );
      try {
        return await operationResult(ctx, op, true, true);
      } catch (error) {
        const result = failure(error);
        result.operation = operationView(op, true);
        if (op.state === 'committed') {
          result.status = 'unknown';
          result.warnings = [
            '原操作已经提交；当前资料无法回读。不要重建或重复执行。',
          ];
        }
        return result;
      }
    }
    if (DIRECT_WRITE_TOOLS.has(name) || EDIT_TOOLS[name])
      return await executeWrite(ctx, name, args);
    return empty('completed', await readV2(ctx, name, args));
  } catch (error) {
    return failure(error);
  }
}
