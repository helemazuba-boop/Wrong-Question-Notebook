import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { findMcpTool, MCP_TOOLS } from '@/lib/mcp/tool-registry';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
import * as noteStudyWeb from '@/lib/note-study-web';
import * as wordStudyWeb from '@/lib/word-study-web';
import * as todos from '@/lib/todos';
import * as notebookContent from '@/lib/notebook-content-service';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const NOTEBOOK_ID = '55555555-5555-4555-8555-555555555555';
const PROBLEM_ID = '33333333-3333-4333-8333-333333333333';
const MCP_TOOL_NAMES = [
  'add_word_entry',
  'create_notebook_note',
  'create_problem_from_images',
  'create_todo',
  'get_learning_overview',
  'get_note',
  'get_note_reading_overview',
  'get_note_reading_session',
  'get_problem_detail',
  'get_todo',
  'get_word_detail',
  'get_word_study_session',
  'list_authorized_notebooks',
  'list_authorized_word_decks',
  'list_notes',
  'list_problem_set_problems',
  'list_problem_sets',
  'list_review_due_problems',
  'list_todos',
  'list_word_entries',
  'list_word_mistakes',
  'list_word_progress',
  'record_note_reading_observation',
  'record_problem_review',
  'record_word_study_observation',
  'search_learning_content',
  'search_user_problems',
  'set_note_reading_session_status',
  'set_word_study_session_status',
  'start_note_reading_session',
  'start_word_study_session',
  'update_notebook_note',
  'update_todo',
  'update_todo_status',
  'update_word_entry',
].sort();

// Minimal chainable supabase mock: from(table) returns a builder whose every
// method returns itself; awaiting resolves to the queued result for the table.
function makeSupabaseMock(
  results: Record<string, { data: unknown; error: unknown }>
) {
  const rpc = vi.fn((_fn: string) =>
    Promise.resolve(results.__rpc ?? { data: null, error: null })
  );
  function builderFor(table: string) {
    const result = results[table] ?? { data: null, error: null };
    const builder: any = {};
    const chain = [
      'select',
      'insert',
      'update',
      'eq',
      'is',
      'lte',
      'or',
      'order',
      'limit',
      'gt',
    ];
    for (const method of chain) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn(() => Promise.resolve(result));
    builder.single = vi.fn(() => Promise.resolve(result));
    builder.then = (resolve: any, reject: any) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  }
  const from = vi.fn((table: string) => builderFor(table));
  const storage = {
    from: vi.fn(() => ({
      createSignedUrls: vi.fn((paths: string[]) =>
        Promise.resolve({
          data: paths.map(path => ({ path, signedUrl: `signed:${path}` })),
          error: null,
        })
      ),
    })),
  };
  return { from, rpc, storage } as any;
}

function ctxWith(
  results: Record<string, { data: unknown; error: unknown }>
): McpToolContext {
  return { userId: USER_ID, supabase: makeSupabaseMock(results) };
}

describe('MCP_TOOLS registry shape', () => {
  it('exposes the planned cross-module tools', () => {
    expect(MCP_TOOLS.map(tool => tool.name).sort()).toEqual(MCP_TOOL_NAMES);
  });

  it('uses unique names and declares safe behavior hints', () => {
    expect(new Set(MCP_TOOLS.map(tool => tool.name)).size).toBe(
      MCP_TOOLS.length
    );
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: false,
        idempotentHint: expect.any(Boolean),
      });
    }
    expect(findMcpTool('create_todo')?.annotations?.idempotentHint).toBe(false);
    expect(
      findMcpTool('create_problem_from_images')?.annotations?.idempotentHint
    ).toBe(true);
  });

  it('every tool carries a JSON Schema object and a description', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('argsSchema stays in sync with the advertised inputSchema contract', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.argsSchema, tool.name).toBeDefined();
      const required = (tool.inputSchema.required as string[]) ?? [];
      const properties =
        (tool.inputSchema.properties as Record<string, unknown>) ?? {};
      // Dropping any advertised-required key must fail validation; a full
      // set of dummy values for every advertised property must not trip the
      // "missing key" branch (it may still fail on value constraints).
      for (const key of required) {
        const withoutKey = Object.fromEntries(
          required.filter(k => k !== key).map(k => [k, 'x'])
        );
        const parsed = tool.argsSchema.safeParse(withoutKey);
        expect(parsed.success, `${tool.name} must require ${key}`).toBe(false);
      }
      // Every zod-known key must be advertised in the JSON schema.
      const advertised = new Set(Object.keys(properties));
      const zodKeys = Object.keys((tool.argsSchema as z.ZodObject).shape ?? {});
      for (const key of zodKeys) {
        expect(advertised.has(key), `${tool.name}.${key} not advertised`).toBe(
          true
        );
      }
    }
  });

  it('findMcpTool resolves known names and rejects unknown ones', () => {
    expect(findMcpTool('get_note')?.name).toBe('get_note');
    expect(findMcpTool('drop_all_tables')).toBeUndefined();
  });

  it('validates image-create and observation protocol boundaries', () => {
    const create = findMcpTool('create_problem_from_images')!;
    const image = { data: 'eA==', mime_type: 'image/png' };
    const validCreate = {
      request_id: 'extract_problem_0001',
      images: [image],
    };
    expect(create.argsSchema.safeParse(validCreate).success).toBe(true);
    expect(
      create.argsSchema.safeParse({ ...validCreate, images: [] }).success
    ).toBe(false);
    expect(
      create.argsSchema.safeParse({
        ...validCreate,
        images: Array.from({ length: 5 }, () => image),
      }).success
    ).toBe(false);
    expect(
      create.argsSchema.safeParse({
        ...validCreate,
        request_id: 'short',
      }).success
    ).toBe(false);
    expect(
      create.argsSchema.safeParse({
        ...validCreate,
        subject_id: 'not-a-uuid',
      }).success
    ).toBe(false);
    expect(
      create.argsSchema.safeParse({
        ...validCreate,
        images: [{ ...image, data: 'x'.repeat(7_000_000) }],
      }).success
    ).toBe(false);

    for (const name of [
      'record_note_reading_observation',
      'record_word_study_observation',
    ]) {
      const tool = findMcpTool(name)!;
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(properties).toHaveProperty('request_id');
      expect(properties).toHaveProperty('session_id');
      expect(properties).toHaveProperty('sequence');
      expect(tool.argsSchema.safeParse({ sequence: -1 }).success).toBe(false);
    }
  });
});

describe('notebook read gating', () => {
  it('list_notes rejects a notebook without can_read', async () => {
    const ctx = ctxWith({
      notebook_ai_access: {
        data: { can_read: false, can_create: true, can_update: false },
        error: null,
      },
    });
    const tool = findMcpTool('list_notes')!;
    await expect(
      tool.handler(ctx, { notebook_id: NOTEBOOK_ID })
    ).rejects.toMatchObject({ code: 'notebook_permission_denied' });
  });

  it('get_note rejects when no access row exists', async () => {
    const ctx = ctxWith({
      notebook_ai_access: { data: null, error: null },
    });
    const tool = findMcpTool('get_note')!;
    await expect(
      tool.handler(ctx, { notebook_id: NOTEBOOK_ID, note_id: PROBLEM_ID })
    ).rejects.toMatchObject({ code: 'notebook_permission_denied' });
  });

  it('update_notebook_note rejects a notebook without can_update', async () => {
    const ctx = ctxWith({
      notebook_ai_access: {
        data: { can_read: true, can_create: true, can_update: false },
        error: null,
      },
    });
    const tool = findMcpTool('update_notebook_note')!;
    await expect(
      tool.handler(ctx, {
        notebook_id: NOTEBOOK_ID,
        note_id: PROBLEM_ID,
        expected_revision: 1,
        title: 'Changed',
      })
    ).rejects.toMatchObject({ code: 'notebook_permission_denied' });
  });

  it('get_note exposes the revision required by update_notebook_note', async () => {
    const getSpy = vi.spyOn(notebookContent, 'getNote').mockResolvedValue({
      id: PROBLEM_ID,
      notebook_id: NOTEBOOK_ID,
      subject_id: null,
      revision: 4,
      title: 'Read me',
      content: 'Body',
      linked_problem_id: null,
      read_state: null,
      assets: [],
      created_at: '2026-08-02T00:00:00.000Z',
      updated_at: '2026-08-02T00:00:00.000Z',
    } as any);
    const ctx = ctxWith({
      notebook_ai_access: {
        data: { can_read: true, can_create: false, can_update: true },
        error: null,
      },
    });
    const result = (await findMcpTool('get_note')!.handler(ctx, {
      notebook_id: NOTEBOOK_ID,
      note_id: PROBLEM_ID,
    })) as any;
    expect(result.note.revision).toBe(4);
    getSpy.mockRestore();
  });
});

describe('session cursor and Word permission gating', () => {
  it('rejects a stale Note observation before recording it', async () => {
    const sessionSpy = vi
      .spyOn(noteStudyWeb, 'loadWebNoteStudySession')
      .mockResolvedValue({
        session_id: '66666666-6666-4666-8666-666666666666',
        notebook_ids: [NOTEBOOK_ID],
        next_sequence: 2,
        current_item: { item_id: PROBLEM_ID },
        status: 'active',
        mode: 'sequential',
      } as any);
    const ctx = ctxWith({
      notebook_ai_access: {
        data: { can_read: true, can_create: false, can_update: false },
        error: null,
      },
    });
    await expect(
      findMcpTool('record_note_reading_observation')!.handler(ctx, {
        request_id: 'note_observation_0001',
        session_id: '66666666-6666-4666-8666-666666666666',
        sequence: 1,
        note_id: PROBLEM_ID,
        action: 'read_completed',
      })
    ).rejects.toMatchObject({ code: 'stale_note_session', status: 409 });
    sessionSpy.mockRestore();
  });

  it('enforces can_create for Word entries', async () => {
    const ctx = ctxWith({
      word_deck_ai_access: {
        data: { can_read: true, can_create: false, can_update: false },
        error: null,
      },
    });
    await expect(
      findMcpTool('add_word_entry')!.handler(ctx, {
        deck_id: NOTEBOOK_ID,
        word: 'orbit',
        meaning: '轨道',
      })
    ).rejects.toMatchObject({ code: 'word_deck_permission_denied' });
  });

  it('enforces can_read for Word detail', async () => {
    const ctx = ctxWith({
      word_entries: {
        data: { deck_id: NOTEBOOK_ID },
        error: null,
      },
      word_deck_ai_access: {
        data: { can_read: false, can_create: true, can_update: true },
        error: null,
      },
    });
    await expect(
      findMcpTool('get_word_detail')!.handler(ctx, {
        word_id: PROBLEM_ID,
      })
    ).rejects.toMatchObject({ code: 'word_deck_permission_denied' });
  });

  it('enforces can_update for Word changes', async () => {
    const ctx = ctxWith({
      word_entries: {
        data: { deck_id: NOTEBOOK_ID },
        error: null,
      },
      word_deck_ai_access: {
        data: { can_read: true, can_create: true, can_update: false },
        error: null,
      },
    });
    await expect(
      findMcpTool('update_word_entry')!.handler(ctx, {
        word_id: PROBLEM_ID,
        expected_revision: 1,
        meaning: 'changed',
      })
    ).rejects.toMatchObject({ code: 'word_deck_permission_denied' });
  });

  it('rejects a stale Word observation before recording it', async () => {
    const sessionSpy = vi
      .spyOn(wordStudyWeb, 'loadWebWordStudySession')
      .mockResolvedValue({
        session_id: '77777777-7777-4777-8777-777777777777',
        deck_ids: [NOTEBOOK_ID],
        next_sequence: 1,
        items: [{ item_id: PROBLEM_ID }, { item_id: NOTEBOOK_ID }],
        status: 'active',
        mode: 'sequential',
      } as any);
    const ctx = ctxWith({
      word_deck_ai_access: {
        data: { can_read: true, can_create: false, can_update: false },
        error: null,
      },
    });
    await expect(
      findMcpTool('record_word_study_observation')!.handler(ctx, {
        request_id: 'word_observation_0001',
        session_id: '77777777-7777-4777-8777-777777777777',
        sequence: 0,
        word_id: PROBLEM_ID,
        action: 'known',
      })
    ).rejects.toMatchObject({ code: 'stale_word_session', status: 409 });
    sessionSpy.mockRestore();
  });
});

describe('Todo extension mapping', () => {
  it('passes nullable links and patch fields through update_todo', async () => {
    const updateSpy = vi
      .spyOn(todos, 'updateTodo')
      .mockResolvedValue({ id: PROBLEM_ID } as any);
    const ctx = ctxWith({});
    await findMcpTool('update_todo')!.handler(ctx, {
      todo_id: PROBLEM_ID,
      title: 'Review later',
      problem_set_id: NOTEBOOK_ID,
      note_id: null,
      word_entry_id: NOTEBOOK_ID,
    });
    expect(updateSpy).toHaveBeenCalledWith(ctx.supabase, USER_ID, PROBLEM_ID, {
      title: 'Review later',
      problem_set_id: NOTEBOOK_ID,
      note_id: null,
      word_entry_id: NOTEBOOK_ID,
    });
    updateSpy.mockRestore();
  });
});

describe('cross-domain search pagination', () => {
  it('returns a real next cursor when the merged result has another page', async () => {
    const ctx = ctxWith({
      problems: {
        data: [
          {
            id: 'p1',
            title: 'Newest',
            subject_id: null,
            updated_at: '2026-08-02T03:00:00.000Z',
          },
          {
            id: 'p2',
            title: 'Middle',
            subject_id: null,
            updated_at: '2026-08-02T02:00:00.000Z',
          },
          {
            id: 'p3',
            title: 'Oldest',
            subject_id: null,
            updated_at: '2026-08-02T01:00:00.000Z',
          },
        ],
        error: null,
      },
    });
    const result = (await findMcpTool('search_learning_content')!.handler(ctx, {
      query: 'motion',
      types: ['problem'],
      limit: 2,
    })) as any;
    expect(result.results.map((item: any) => item.resource_id)).toEqual([
      'p1',
      'p2',
    ]);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe('2');
  });
});

describe('record_problem_review', () => {
  const rpcResult = {
    observation_id: '44444444-4444-4444-8444-444444444444',
    problem_id: PROBLEM_ID,
    action: 'correct',
    status: 'mastered',
    schedule: {
      next_review_at: '2026-07-31T16:00:00+00:00',
      interval_days: 3,
      ease_factor: 2.6,
      repetition_number: 2,
    },
    projection_applied: true,
    replayed: false,
  };

  it('maps args onto the RPC with device_id null', async () => {
    const ctx = ctxWith({ __rpc: { data: rpcResult, error: null } });
    const tool = findMcpTool('record_problem_review')!;
    const result = (await tool.handler(ctx, {
      problem_id: PROBLEM_ID,
      action: 'correct',
      request_id: 'mcp_review_request_001',
    })) as { review: { status: string } };

    expect(result.review.status).toBe('mastered');
    const rpc = (ctx.supabase as any).rpc;
    expect(rpc).toHaveBeenCalledWith(
      'record_problem_review_v1',
      expect.objectContaining({
        p_user_id: USER_ID,
        p_device_id: null,
        p_request_id: 'mcp_review_request_001',
        p_problem_id: PROBLEM_ID,
        p_action: 'correct',
      })
    );
  });

  it('generates a 32-hex request_id when the caller omits one', async () => {
    const ctx = ctxWith({ __rpc: { data: rpcResult, error: null } });
    const tool = findMcpTool('record_problem_review')!;
    await tool.handler(ctx, { problem_id: PROBLEM_ID, action: 'correct' });
    const rpc = (ctx.supabase as any).rpc;
    const requestId = rpc.mock.calls[0][1].p_request_id as string;
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('get_problem_detail', () => {
  it('returns per-part statements and signed image urls', async () => {
    const ctx = ctxWith({
      problems: {
        data: {
          id: PROBLEM_ID,
          title: '数列综合',
          content: '',
          solution_text: '见解析',
          status: 'needs_review',
          subjects: { name: '数学' },
          parts: [
            {
              index: 1,
              label: '第(1)问',
              type: 'short_answer',
              full_marks: 6,
              content: '求通项公式',
              correct_answer: 'a_n = 2n',
            },
          ],
          assets: [
            { path: 'user/u/p/a.jpg', display_path: 'user/u/p/a_d.png' },
          ],
          solution_assets: [],
        },
        error: null,
      },
    });
    const tool = findMcpTool('get_problem_detail')!;
    const result = (await tool.handler(ctx, { problem_id: PROBLEM_ID })) as any;

    expect(result.problem.parts).toEqual([
      {
        index: 1,
        label: '第(1)问',
        type: 'short_answer',
        full_marks: 6,
        content_text: '求通项公式',
        correct_answer: 'a_n = 2n',
      },
    ]);
    // display_path wins over path, and the signing mock echoes it back.
    expect(result.problem.problem_images).toEqual([
      { path: 'user/u/p/a_d.png', url: 'signed:user/u/p/a_d.png' },
    ]);
    expect(result.problem.solution_images).toEqual([]);
  });
});
