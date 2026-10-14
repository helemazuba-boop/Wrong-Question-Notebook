import { z } from 'zod';

// External-only contracts. Do not import this module from the dependency-free
// ESP32 catalog: that catalog is the intentionally preserved v1 projection.
export const MCP_V2_VERSION = '2.0.0';
export const MCP_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MCP_LEASE_MS = 5 * 60 * 1000;
export const MCP_LEASE_RENEW_MS = 30 * 1000;
export const Id = z.uuid();
export const RequestId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const Cursor = z.string().regex(/^(?:0|[1-9][0-9]{0,3}|10000)$/);
const Time = z.iso.datetime({ offset: true });
const Revision = z.number().int().positive();
const Nonblank = (max: number) => z.string().min(1).max(max).regex(/\S/);
const OptId = Id.nullish();
const Limit = (max: number) => z.number().int().min(1).max(max).optional();
const Tags = z.array(Nonblank(30)).max(20);
const PartType = z.enum([
  'single_choice',
  'multi_choice',
  'fill_blank',
  'short_answer',
  'essay',
]);
const Choice = z.strictObject({ id: Nonblank(10), text: z.string().max(500) });
const AnswerHint = z.strictObject({
  mcq_correct_choice_id: z.string().max(40).nullish(),
  short_answer_value: z.string().max(5000).nullish(),
  short_answer_is_numeric: z.boolean().nullish(),
  extended_working: z.string().max(5000).nullish(),
  answer_confidence: z.enum(['high', 'medium', 'low']).optional(),
});
const DraftPart = z.strictObject({
  index: z.number().int().min(1).max(10),
  label: z.string().max(16).nullish(),
  type: PartType,
  content: z.string().max(5000),
  full_marks: z.number().int().min(0).max(150).nullish(),
  mcq_choices: z.array(Choice).max(10),
  answer_hint: AnswerHint.nullish(),
});
const Confidence = z.strictObject({
  problem_type_confidence: z.enum(['high', 'medium', 'low']),
  content_quality: z.enum(['clear', 'partially_unclear', 'unclear']),
  has_math: z.boolean(),
  warnings: z.array(z.string().max(1000)).max(50),
});
export const CreateProblemArgs = z.strictObject({
  request_id: RequestId,
  title: Nonblank(200),
  content: z.string().max(5000),
  parts: z.array(DraftPart).min(1).max(10),
  suggest_image_asset: z
    .boolean()
    .describe(
      '题目依赖未提供的图像时设为 true；保存普通题目并返回 WQN 补图入口。'
    ),
  subject_id: OptId,
  problem_set_id: OptId,
  tags: Tags.optional(),
  confidence: Confidence.optional(),
  solution_text: z.string().max(5000).nullish(),
  initial_idea_draft: Nonblank(4000).optional(),
});

export const AssetReference = z.strictObject({
  path: Nonblank(1024),
  role: z
    .enum(['question', 'answer', 'solution', 'student_work', 'other'])
    .optional(),
});
const StoredPart = z.strictObject({
  index: z.number().int().min(1).max(10),
  type: PartType,
  label: z.string().max(16).nullish(),
  full_marks: z.number().int().min(0).max(150).nullish(),
  content: z.string().max(5000),
  correct_answer: z.string().max(5000).nullish(),
  mcq_choices: z.array(Choice).max(10).optional(),
  answer_config: z.record(z.string(), z.json()).nullish(),
});
// User-editable provenance is deliberately separated from server audit fields.
const ExamSource = z.strictObject({
  paper: z.string().max(60).nullish(),
  year: z.number().int().min(1900).max(2100).nullish(),
  question_no: z.string().max(16).nullish(),
  exam_type: z.enum(['real', 'mock', 'homework', 'other']).nullish(),
});
export const ProblemChanges = z.strictObject({
  title: Nonblank(200).optional(),
  content: z.string().max(5000).optional(),
  subject_id: Id.optional(),
  parts: z.array(StoredPart).min(1).max(10).optional(),
  solution_text: z.string().max(5000).nullable().optional(),
  assets: z.array(AssetReference).max(100).optional(),
  solution_assets: z.array(AssetReference).max(100).optional(),
  tag_ids: z.array(Id).max(100).optional(),
  tags: Tags.optional(),
  initial_idea: z.string().max(4000).nullable().optional(),
  exam_source: ExamSource.optional(),
  is_optional: z.boolean().optional(),
  status: z.enum(['wrong', 'needs_review', 'mastered']).optional(),
});
export const NoteChanges = z.strictObject({
  title: Nonblank(120).optional(),
  content: z.string().max(4000).optional(),
  linked_problem_id: OptId,
});
export const WordChanges = z.strictObject({
  word: Nonblank(80).optional(),
  meaning: Nonblank(1000).optional(),
  phonetic: z.string().max(120).nullish(),
  example: z.string().max(1000).nullish(),
  example_translation: z.string().max(1000).nullish(),
  part_of_speech: z.string().max(80).nullish(),
  tags: z.array(Nonblank(40)).max(16).optional(),
});
const TodoFields = {
  title: Nonblank(120),
  description: z.string().max(2000).nullish(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  due_at: Time.nullish(),
  reminder_at: Time.nullish(),
  subject_id: OptId,
  problem_set_id: OptId,
  problem_id: OptId,
  notebook_id: OptId,
  note_id: OptId,
  word_deck_id: OptId,
  word_entry_id: OptId,
};
export const TodoChanges = z.strictObject(TodoFields).partial();
export const ProposalSchemas = {
  problem: ProblemChanges,
  note: NoteChanges,
  word: WordChanges,
  todo: TodoChanges,
} as const;
export type ProposalResource = keyof typeof ProposalSchemas;

const permissions = z.object({
  can_read: z.boolean(),
  can_create: z.boolean(),
  can_update: z.literal(false),
  can_propose_updates: z.boolean(),
});
const counters = z.record(z.string(), z.number());
const progress = z.object({
  status: z.string(),
  due_at: z.string().nullable().optional(),
  reviewed_count: z.number().optional(),
  known_count: z.number().optional(),
  unknown_count: z.number().optional(),
});
const image = z.object({
  path: z.string(),
  url: z.string().nullable(),
  role: z
    .enum(['question', 'answer', 'solution', 'student_work', 'other'])
    .optional(),
});
const part = z.object({
  index: z.number().int(),
  type: PartType,
  label: z.string().nullable(),
  full_marks: z.number().nullable(),
  content_text: z.string(),
  content_html: z.string(),
  correct_answer: z.string().nullable(),
  mcq_choices: z.array(Choice).nullable(),
  answer_config: z.record(z.string(), z.json()).nullable().optional(),
});
// DTO fields are explicit, including the richer optional fields shared by
// lists/details. Parsing projects domain rows; arbitrary DB columns never leak.
export const ResourceDto = z.object({
  id: z.string(),
  resource_type: z.enum([
    'problem',
    'problem_set',
    'note',
    'notebook',
    'word',
    'word_deck',
    'todo',
  ]),
  title: z.string(),
  revision: z.number().int().optional(),
  subject_id: z.string().nullable().optional(),
  subject_name: z.string().optional(),
  status: z.string().optional(),
  updated_at: z.string().nullable().optional(),
  content_text: z.string().optional(),
  content_html: z.string().optional(),
  content: z.string().optional(),
  content_format: z.string().optional(),
  read_state: z
    .object({
      state: z.string(),
      last_completed_at: z.string().nullable().optional(),
      completed_count: z.number().optional(),
    })
    .optional(),
  solution_text: z.string().optional(),
  solution_html: z.string().optional(),
  parts: z.array(part).optional(),
  structure_complete: z.boolean().optional(),
  problem_images: z.array(image).optional(),
  images: z.array(image).optional(),
  image_count: z.number().int().nonnegative().optional(),
  solution_images: z.array(image).optional(),
  image_completion_required: z.boolean().optional(),
  web_url: z.string().optional(),
  image_upload_url: z.string().optional(),
  exam_source: ExamSource.optional(),
  evidence: z
    .object({
      answer_origin: z.string().nullable(),
      solution_origin: z.string().nullable(),
      initial_idea_origin: z.string().nullable(),
    })
    .optional(),
  extraction_warnings: z.array(z.string()).optional(),
  initial_idea: z.string().nullable().optional(),
  initial_idea_revision: z.number().nullable().optional(),
  tags: z.array(z.string()).optional(),
  permissions: permissions.optional(),
  tag_ids: z.array(z.string()).optional(),
  summary: counters.optional(),
  word_deck_id: z.string().nullable().optional(),
  notebook_id: z.string().nullable().optional(),
  linked_problem_id: z.string().nullable().optional(),
  word: z.string().optional(),
  meaning: z.string().optional(),
  phonetic: z.string().nullable().optional(),
  example: z.string().nullable().optional(),
  example_translation: z.string().nullable().optional(),
  part_of_speech: z.string().nullable().optional(),
  progress: progress.optional(),
  description: z.string().optional(),
  priority: z.string().optional(),
  due_at: z.string().nullable().optional(),
  reminder_at: z.string().nullable().optional(),
  next_review_at: z.string().nullable().optional(),
  interval_days: z.number().nullable().optional(),
  repetition_number: z.number().nullable().optional(),
  is_smart: z.boolean().optional(),
  problem_count: z.number().int().optional(),
  note_count: z.number().int().optional(),
  entry_count: z.number().int().optional(),
  language: z.string().optional(),
  target_language: z.string().optional(),
  available: z.boolean().optional(),
  ordinal: z.number().int().optional(),
});
const Page = z.object({
  items: z.array(ResourceDto),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  total: z.number().int().nonnegative().nullable(),
});
const Item = z.object({ item: ResourceDto });
const Session = z.object({
  session: z.object({
    session_id: z.string(),
    status: z.string(),
    mode: z.string(),
    candidate_count: z.number().int(),
    next_sequence: z.number().int(),
    started_at: z.string().optional(),
    expires_at: z.string().optional(),
    notebook_ids: z.array(z.string()).optional(),
    word_deck_ids: z.array(z.string()).optional(),
    result: counters,
  }),
  current_item: ResourceDto.nullable(),
});
const Observation = z.object({
  observation_id: z.string().optional(),
  session_id: z.string().optional(),
  sequence: z.number().int().optional(),
  item_id: z.string().optional(),
  action: z.string().optional(),
  replayed: z.boolean().optional(),
  next_sequence: z.number().int().optional(),
  completed: z.boolean().optional(),
  problem_id: z.string().optional(),
  applied: z.boolean().optional(),
  next_review_at: z.string().nullable().optional(),
  state_after: z.string().optional(),
  status: z.string().optional(),
  projection_applied: z.boolean().optional(),
  schedule: z
    .object({
      next_review_at: z.string().nullable(),
      interval_days: z.number(),
      ease_factor: z.number(),
      repetition_number: z.number(),
    })
    .nullable()
    .optional(),
});
const OperationView = z.object({
  operation_id: Id,
  tool_name: z.string(),
  request_id: RequestId,
  execution_state: z.enum([
    'preparing',
    'prepared',
    'awaiting_approval',
    'committed',
    'failed',
    'rejected',
    'legacy_unverified',
  ]),
  replayed: z.boolean(),
  recover_until: z.string(),
  created_at: z.string(),
});
export const NextAction = z.object({
  kind: z.enum(['call_tool', 'open_wqn', 'report']),
  description: z.string(),
  tool_name: z.string().optional(),
  arguments: z.record(z.string(), z.json()).optional(),
  url: z.string().optional(),
});
export const ErrorDto = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  fields: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});
export const ResultStatus = z.enum([
  'completed',
  'requires_user_action',
  'in_progress',
  'failed',
  'unknown',
]);
export function resultSchema(data: z.ZodType) {
  return z.strictObject({
    status: ResultStatus,
    data: data.nullable(),
    error: ErrorDto.nullable(),
    operation: OperationView.nullable(),
    next_actions: z.array(NextAction),
    warnings: z.array(z.string()),
  });
}
export type McpV2Result = {
  status: z.infer<typeof ResultStatus>;
  data: unknown;
  error: z.infer<typeof ErrorDto> | null;
  operation: z.infer<typeof OperationView> | null;
  next_actions: z.infer<typeof NextAction>[];
  warnings: string[];
};

const base = { request_id: RequestId };
const paging = { cursor: Cursor.optional(), limit: Limit(50) };
const readSubject = { subject_id: OptId };
const sessionState = {
  ...base,
  session_id: Id,
  status: z.enum(['active', 'paused', 'completed', 'abandoned']),
};
const wordFields = {
  ...WordChanges.shape,
  word: Nonblank(80),
  meaning: Nonblank(1000),
};
const inputs = {
  list_word_progress: z.strictObject({ word_deck_id: OptId }),
  list_word_mistakes: z.strictObject({ limit: Limit(50) }),
  get_word_study_session: z.strictObject({ session_id: Id }),
  create_word_deck: z.strictObject({
    ...base,
    title: Nonblank(80),
    description: z.string().max(500).nullish(),
    ...readSubject,
    language: z.string().max(16).optional(),
    target_language: z.string().max(16).optional(),
    lexicon_type: z.literal('english_word').optional(),
  }),
  search_words: z.strictObject({
    query: z.string().max(80).optional(),
    prefix: z.string().max(80).optional(),
    word_deck_id: OptId,
    limit: Limit(20),
  }),
  list_review_due_problems: z.strictObject({ limit: Limit(20) }),
  search_user_problems: z.strictObject({
    query: Nonblank(200),
    ...readSubject,
    limit: Limit(5),
  }),
  get_problem_detail: z.strictObject({ problem_id: Id }),
  record_problem_review: z.strictObject({
    ...base,
    problem_id: Id,
    action: z.enum(['correct', 'hesitant', 'wrong', 'skip']),
  }),
  list_authorized_notebooks: z.strictObject({}),
  list_notes: z.strictObject({
    notebook_id: Id,
    query: z.string().max(200).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: Limit(100),
  }),
  get_note: z.strictObject({ notebook_id: Id, note_id: Id }),
  create_notebook_note: z.strictObject({
    ...base,
    notebook_id: Id,
    title: Nonblank(120),
    content: z.string().max(4000),
    linked_problem_id: OptId,
  }),
  list_todos: z.strictObject({
    status: z.enum(['pending', 'completed', 'cancelled', 'all']).optional(),
    ...readSubject,
    limit: Limit(50),
  }),
  create_todo: z.strictObject({ ...base, ...TodoFields }),
  update_todo_status: z.strictObject({
    ...base,
    todo_id: Id,
    status: z.enum(['pending', 'completed', 'cancelled']),
  }),
  get_learning_overview: z.strictObject({ limit: Limit(20) }),
  search_learning_content: z.strictObject({
    query: Nonblank(200),
    types: z
      .array(z.enum(['problem', 'note', 'word', 'todo']))
      .min(1)
      .max(4)
      .optional(),
    ...readSubject,
    ...paging,
    limit: Limit(40),
  }),
  list_problem_sets: z.strictObject({ ...readSubject, ...paging }),
  list_problem_set_problems: z.strictObject({ problem_set_id: Id, ...paging }),
  create_problem: CreateProblemArgs,
  create_problem_from_images: z.strictObject({
    ...base,
    source_assets: z.array(AssetReference).min(1).max(4),
    ...readSubject,
    problem_set_id: OptId,
    initial_idea_draft: Nonblank(4000).optional(),
    solution_text: z.string().max(5000).nullish(),
  }),
  update_notebook_note: z.strictObject({
    ...base,
    notebook_id: Id,
    note_id: Id,
    expected_revision: Revision,
    changes: NoteChanges,
  }),
  get_note_reading_overview: z.strictObject({
    notebook_id: OptId,
    recent_limit: Limit(40),
  }),
  start_note_reading_session: z.strictObject({
    ...base,
    notebook_ids: z.array(Id).min(1).max(32),
    mode: z.enum(['sequential', 'recent']),
    optional_count: Limit(500),
    seed: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  }),
  get_note_reading_session: z.strictObject({ session_id: Id }),
  record_note_reading_observation: z.strictObject({
    ...base,
    session_id: Id,
    sequence: z.number().int().nonnegative(),
    note_id: Id,
    action: z.enum(['read_completed', 'skipped']),
    occurred_at: Time.optional(),
  }),
  set_note_reading_session_status: z.strictObject(sessionState),
  list_authorized_word_decks: z.strictObject({}),
  list_word_entries: z.strictObject({
    word_deck_id: Id,
    query: z.string().max(200).optional(),
    ...paging,
    limit: Limit(100),
  }),
  get_word_detail: z.strictObject({ word_entry_id: Id }),
  add_word_entry: z.strictObject({ ...base, word_deck_id: Id, ...wordFields }),
  update_word_entry: z.strictObject({
    ...base,
    word_entry_id: Id,
    expected_revision: Revision,
    changes: WordChanges,
  }),
  start_word_study_session: z.strictObject({
    ...base,
    word_deck_ids: z.array(Id).min(1).max(32),
    mode: z.enum(['sequential', 'random', 'dictionary']),
    include_mastered: z.boolean().optional(),
    optional_count: Limit(500),
    seed: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  }),
  record_word_study_observation: z.strictObject({
    ...base,
    session_id: Id,
    sequence: z.number().int().nonnegative(),
    word_entry_id: Id,
    action: z.enum(['known', 'unknown', 'skipped']),
    occurred_at: Time.optional(),
  }),
  set_word_study_session_status: z.strictObject(sessionState),
  get_todo: z.strictObject({ todo_id: Id }),
  update_todo: z.strictObject({
    ...base,
    todo_id: Id,
    expected_revision: Revision,
    changes: TodoChanges,
  }),
  submit_problem_update: z.strictObject({
    ...base,
    problem_id: Id,
    expected_revision: Revision,
    expected_initial_idea_revision: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    changes: ProblemChanges,
  }),
  get_workflow_guide: z.strictObject({}),
  get_problem_creation_spec: z.strictObject({}),
  get_operation_status: z.strictObject({
    tool_name: Nonblank(100),
    request_id: RequestId,
  }),
  resume_operation: z.strictObject({ operation_id: Id }),
} as const;
export type McpV2ToolName = keyof typeof inputs;

const proposal = (changes: z.ZodType) =>
  z.object({
    proposal_id: Id,
    resource_type: z.enum(['problem', 'note', 'word', 'todo']),
    resource_id: Id,
    expected_revision: Revision,
    changes,
  });
const overview = z.object({
  generated_at: z.string(),
  problems: z.array(ResourceDto),
  notebooks: z.array(ResourceDto),
  word_decks: z.array(ResourceDto),
  todos: z.array(ResourceDto),
  recent_notes: z.array(ResourceDto),
});
const guide = z.object({
  contract_version: z.string(),
  instructions: z.string(),
  workflows: z.array(
    z.object({
      task: z.string(),
      steps: z.array(z.string()),
      tools: z.array(z.string()),
      limitations: z.array(z.string()),
    })
  ),
});
const spec = z.object({
  contract_version: z.string(),
  prompt: z.string(),
  input_schema: z.record(z.string(), z.json()),
  examples: z.array(CreateProblemArgs),
});
const operationData = z.object({
  operation_id: Id,
  tool_name: z.string(),
  execution_state: z.string(),
  resource_type: z.string().nullable(),
  resource_id: z.string().nullable(),
  pending_actions: z.array(z.string()),
  result: z
    .object({
      item: ResourceDto.optional(),
      session_id: z.string().optional(),
      proposal_id: z.string().optional(),
    })
    .nullable(),
});
const sessionNames = new Set([
  'get_word_study_session',
  'get_note_reading_session',
  'start_note_reading_session',
  'start_word_study_session',
  'set_note_reading_session_status',
  'set_word_study_session_status',
]);
const itemNames = new Set([
  'get_problem_detail',
  'get_note',
  'get_word_detail',
  'get_todo',
  'create_problem',
  'create_problem_from_images',
  'create_notebook_note',
  'create_word_deck',
  'create_todo',
  'add_word_entry',
  'update_todo_status',
]);
const directWrites = new Set([
  'create_problem',
  'create_problem_from_images',
  'create_notebook_note',
  'create_word_deck',
  'create_todo',
  'add_word_entry',
  'update_todo_status',
  'record_problem_review',
  'start_note_reading_session',
  'record_note_reading_observation',
  'set_note_reading_session_status',
  'start_word_study_session',
  'record_word_study_observation',
  'set_word_study_session_status',
]);
export const EDIT_TOOLS: Partial<Record<McpV2ToolName, ProposalResource>> = {
  submit_problem_update: 'problem',
  update_notebook_note: 'note',
  update_word_entry: 'word',
  update_todo: 'todo',
};
export const DIRECT_WRITE_TOOLS = directWrites;
export const MCP_V2_INSTRUCTIONS =
  'WQN MCP v2：先按 get_workflow_guide 选择任务路径。每个独立写操作生成全新的 request_id（同一用户跨工具唯一），只有完全相同的重试才复用。学习观察仅记录用户报告的实际完成结果，不替用户猜测掌握程度。创建题目前可读取 get_problem_creation_spec。所有内容编辑只保存提案，须用户到 WQN 审核后才生效；不得代用户批准或确认原话。图片由用户在 WQN 上传，不能声称已读取尚未提供的图片。检查 status 与 operation.execution_state，等待用户或结果未知均不是任务完成。缺少能力时说明限制，不擅自改建 Note 或将错因塞入 tags。超时查询 get_operation_status；resume_operation 不能修改原输入或绕过审核。';
const descriptions: Partial<Record<McpV2ToolName, string>> = {
  get_workflow_guide:
    '读取 WQN 任务指南、权限、工具路径和完成条件；首次使用或能力不明时调用。',
  get_problem_creation_spec:
    '读取完整建题 Schema、识别 Prompt 和有效示例。只读，不创建题目。',
  create_problem:
    '保存一条已经选定的普通题目；无需先上传图片。识别字段保留印刷事实，缺失 answer_hint 可为 null。图片依赖会返回 WQN 补图入口；个人思路须用户确认。完整 Schema 见 get_problem_creation_spec。',
  create_problem_from_images:
    '从 WQN 已上传且用户拥有的 source_assets 识别并创建单题；不上传图片，不接收 base64。已有题补图应打开其 WQN 链接，不能重建同一道题。',
  get_operation_status:
    '查询原操作实际提交与审核状态。回执不受 24 小时自动恢复窗口影响。',
  resume_operation:
    '恢复原操作，自动写入仅在 24 小时内。已提交操作只重放回执，等待审核则返回 WQN 链接；不能编辑输入、替用户批准或重建已删除内容。',
  add_word_entry:
    '向已授权 can_create 的 Word 词库新增词条。同名冲突不会覆盖；修改已有词条请提交 update_word_entry 提案。',
  create_word_deck:
    '创建词库，不自动赋予 AI 访问权限；返回 WQN 手动授权入口，授权前不能继续加词。',
  record_note_reading_observation:
    '确认当前笔记已读完或跳过（read_completed/skipped）；仅终结动作推进 sequence。必须复用 request_id 重试，禁止猜测序号。',
  record_word_study_observation:
    '确认当前词条记得、不记得或跳过（known/unknown/skipped）；一次推进一个 sequence。必须复用 request_id 重试。',
  start_word_study_session:
    '从已授权词库创建学习会话，仅返回当前项、统计与 next_sequence；新增会话和重试均需 request_id。',
  start_note_reading_session:
    '从已授权笔记本创建阅读会话，仅返回当前项、统计与 next_sequence；新增会话和重试均需 request_id。',
};
export function buildV2Tools(legacyDescriptions: Record<string, string> = {}) {
  return Object.entries(inputs).map(([name, argsSchema]) => {
    const toolName = name as McpV2ToolName;
    const edit = EDIT_TOOLS[toolName];
    const readOnly =
      !directWrites.has(name) && !edit && name !== 'resume_operation';
    let dataSchema: z.ZodType = Page;
    if (itemNames.has(name)) dataSchema = Item;
    if (sessionNames.has(name)) dataSchema = Session;
    if (name.startsWith('record_'))
      dataSchema = z.object({
        observation: Observation,
        session: Session.shape.session.optional(),
        current_item: ResourceDto.nullable().optional(),
      });
    if (edit) dataSchema = proposal(ProposalSchemas[edit]);
    if (name === 'get_learning_overview') dataSchema = overview;
    if (name === 'get_note_reading_overview')
      dataSchema = z.object({
        notebooks: z.array(ResourceDto),
        recent_notes: z.array(ResourceDto),
      });
    if (name === 'get_workflow_guide') dataSchema = guide;
    if (name === 'get_problem_creation_spec') dataSchema = spec;
    if (name === 'get_operation_status' || name === 'resume_operation')
      dataSchema = operationData;
    const output = resultSchema(dataSchema);
    const description = edit
      ? `提交 ${edit} 内容修改提案；所有可编辑字段可提议，必须用户在 WQN 逐次审核后才生效。本次调用不会修改目标；expected_revision 防止覆盖，changes 仅包含要改的字段。`
      : (descriptions[toolName] ?? legacyDescriptions[name] ?? name);
    return {
      name: toolName,
      description,
      argsSchema,
      dataSchema,
      resultSchema: output,
      inputSchema: z.toJSONSchema(argsSchema, {
        target: 'draft-2020-12',
        io: 'input',
        unrepresentable: 'throw',
      }),
      outputSchema: z.toJSONSchema(output, {
        target: 'draft-2020-12',
        io: 'output',
        unrepresentable: 'throw',
      }),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: true,
      },
    };
  });
}
