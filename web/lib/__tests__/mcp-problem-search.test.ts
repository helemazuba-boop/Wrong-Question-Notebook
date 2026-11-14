import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readV2 } from '@/lib/mcp/v2-readers';
import { findMcpTool, type McpToolContext } from '@/lib/mcp/tool-registry';

const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const subject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fetchMock = vi.fn();
const context = (): McpToolContext => ({
  userId: uid,
  supabase: createClient('https://supabase.example', 'test-key', {
    global: { fetch: fetchMock },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
});
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () =>
    Response.json([
      {
        id,
        title: '空间站轨道周期',
        status: 'needs_review',
        subject_id: subject,
        subjects: { name: '物理' },
        updated_at: '2026-11-12T00:00:00Z',
        content: '',
        parts: [
          { index: 1, type: 'short_answer', content: '' },
          { index: 2, type: 'short_answer', content: '24h累计受光时长' },
        ],
      },
    ])
  );
});

describe('MCP problem search through production adapters', () => {
  it.each(['search_user_problems', 'search_learning_content'] as const)(
    '%s keeps the keyword, owner, subject and database pagination',
    async name => {
      const data = await readV2(context(), name, {
        query: '受光',
        subject_id: subject,
        limit: 2,
        ...(name === 'search_learning_content'
          ? { types: ['problem'], cursor: '0' }
          : {}),
      });
      expect(data.items).toEqual([
        expect.objectContaining({ id, title: '空间站轨道周期' }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe('/rest/v1/problems');
      expect(url.searchParams.get('user_id')).toBe(`eq.${uid}`);
      expect(url.searchParams.get('subject_id')).toBe(`eq.${subject}`);
      expect(url.searchParams.get('or')).toContain('title.ilike."%受光%"');
      expect(url.searchParams.get('or')).toContain(
        'parts->1->>content.ilike."%受光%"'
      );
      expect(url.searchParams.get('or')).toContain(
        'parts->9->>content.ilike."%受光%"'
      );
      expect(url.searchParams.get('limit')).toBe(
        name === 'search_user_problems' ? '2' : '3'
      );
      expect(url.searchParams.get('order')).toContain('updated_at.desc');
    }
  );
  it('rejects a lost or blank keyword instead of listing unrelated recent problems', async () => {
    await expect(
      findMcpTool('search_user_problems')!.handler(context(), { query: ' ' })
    ).rejects.toMatchObject({ code: 'invalid_query' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('quotes search delimiters rather than introducing another filter', async () => {
    await readV2(context(), 'search_user_problems', {
      query: 'R+h,"地影"\\角',
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('or')).toContain(
      'title.ilike."%R+h,\\"地影\\"\\\\角%"'
    );
  });
});
