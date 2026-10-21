import { z } from 'zod';
import { findMcpTool } from '@/lib/mcp/tool-registry';
export const RelativeTimeSchema = z
  .strictObject({
    date: z
      .string()
      .regex(/^(today|tomorrow|day_after_tomorrow|\d{4}-\d{2}-\d{2})$/)
      .optional(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    offset_minutes: z.number().int().min(1).max(525600).optional(),
  })
  .refine(
    v =>
      v.offset_minutes !== undefined
        ? v.date === undefined && v.time === undefined
        : v.date !== undefined,
    'date 或 offset_minutes 必须且只能选一个'
  );
const CreateTodoSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000).nullish(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    due_at: z.iso.datetime({ offset: true }).nullish(),
    reminder_at: z.iso.datetime({ offset: true }).nullish(),
    due: RelativeTimeSchema.optional(),
    reminder: RelativeTimeSchema.optional(),
    subject_id: z.uuid().nullish(),
    problem_set_id: z.uuid().nullish(),
    problem_id: z.uuid().nullish(),
    notebook_id: z.uuid().nullish(),
    note_id: z.uuid().nullish(),
  })
  .refine(
    v =>
      !(v.due && v.due_at !== undefined) &&
      !(v.reminder && v.reminder_at !== undefined),
    '相对和绝对时间不能同时传入'
  );
const CreateNoteSchema = z.strictObject({
  notebook_id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4000),
  linked_problem_id: z.uuid().nullish(),
});
export function voiceArgsSchema(name: string) {
  if (name === 'create_todo') return CreateTodoSchema;
  if (name === 'create_notebook_note') return CreateNoteSchema;
  return findMcpTool(name)!.argsSchema;
}
