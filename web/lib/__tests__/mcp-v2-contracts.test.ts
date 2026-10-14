import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { buildV2Tools } from '@/lib/mcp/v2-contracts';
import { canonicalJson, fingerprint } from '@/lib/mcp/v2-operations';
const tools = buildV2Tools();
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const sample = {
  request_id: 'problem_request_01',
  title: '原题',
  content: '',
  parts: [
    {
      index: 1,
      label: null,
      type: 'multi_choice',
      content: '选择正确项',
      full_marks: null,
      mcq_choices: [
        { id: 'A', text: 'a' },
        { id: 'B', text: 'b' },
      ],
      answer_hint: null,
    },
  ],
  suggest_image_asset: true,
};
describe('published MCP v2 contract', () => {
  it('compiles every advertised input and output in a real JSON Schema validator', () => {
    for (const t of tools) {
      expect(() => ajv.compile(t.inputSchema)).not.toThrow();
      expect(() => ajv.compile(t.outputSchema)).not.toThrow();
    }
  });
  it('allows null consistently in client validation and the server parser', () => {
    const t = tools.find(t => t.name === 'create_problem')!;
    expect(ajv.compile(t.inputSchema)(sample)).toBe(true);
    expect(t.argsSchema.safeParse(sample).success).toBe(true);
    const empty = {
      ...sample,
      parts: [
        {
          ...sample.parts[0],
          answer_hint: {
            mcq_correct_choice_id: null,
            short_answer_value: null,
            short_answer_is_numeric: null,
            extended_working: null,
          },
        },
      ],
    };
    expect(ajv.compile(t.inputSchema)(empty)).toBe(true);
    expect(t.argsSchema.safeParse(empty).success).toBe(true);
  });
  it('does not silently strip unknown business or audit keys', () => {
    const t = tools.find(t => t.name === 'create_problem')!;
    const invalid = { ...sample, owner_id: 'forged' };
    expect(ajv.compile(t.inputSchema)(invalid)).toBe(false);
    expect(t.argsSchema.safeParse(invalid).success).toBe(false);
    const proposal = tools.find(t => t.name === 'submit_problem_update')!;
    expect(
      proposal.argsSchema.safeParse({
        request_id: 'update_request_01',
        problem_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expected_revision: 1,
        changes: { revision: 99 },
      }).success
    ).toBe(false);
  });
  it('fingerprints the complete stable input including initial idea and explicit clears', () => {
    expect(fingerprint('create_problem', sample)).toBe(
      fingerprint('create_problem', JSON.parse(canonicalJson(sample)))
    );
    expect(
      fingerprint('create_problem', {
        ...sample,
        initial_idea_draft: 'my idea',
      })
    ).not.toBe(fingerprint('create_problem', sample));
    expect(fingerprint('update_word_entry', { phonetic: null })).not.toBe(
      fingerprint('update_word_entry', {})
    );
  });
  it('requires Word deck asset references and keeps Note cursors opaque', () => {
    const image = tools.find(t => t.name === 'create_problem_from_images')!;
    expect(
      image.argsSchema.safeParse({
        request_id: 'image_request_0001',
        images: [{ data: 'base64' }],
      }).success
    ).toBe(false);
    expect(
      image.argsSchema.safeParse({
        request_id: 'image_request_0001',
        source_assets: [{ path: 'user/owner/problempath', role: 'question' }],
      }).success
    ).toBe(true);
    expect(
      tools
        .find(t => t.name === 'list_notes')!
        .argsSchema.safeParse({
          notebook_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          cursor: 'eyJvcmRlciI6ImNyZWF0ZWQifQ',
        }).success
    ).toBe(true);
  });
});
