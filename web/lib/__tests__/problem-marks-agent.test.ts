import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AgentBundleSchema,
  AgentMarkResultSchema,
  markingEngine,
  validateAgentEvidence,
} from '@/lib/problem-marks/agent-contract';

const bundle = AgentBundleSchema.parse(
  JSON.parse(readFileSync('agent-marking.bundle.json', 'utf8'))
);
const doc = bundle.documents[0];
const base = {
  assignments: [],
  methods: [
    {
      mark_key: doc.stable_key,
      preference: 'recommended',
      part_index: 1,
      evidence: {
        problem_field: 'parts.1.content',
        problem_quote: '已知三个物理量',
        document_key: doc.stable_key,
        section_id: doc.sections[0].id,
        document_quote: doc.sections[0].text.slice(0, 30),
        rationale: '条件与该方法一致。',
      },
    },
  ],
  unresolved: [],
};
const context = {
  subject_key: 'physics',
  evidence_fields: { 'parts.1.content': '已知三个物理量，求第四个。' },
  part_indexes: [1],
};
afterEach(() => vi.unstubAllEnvs());
describe('Agent marking contract and grounded evidence', () => {
  it('keeps the RAG default and rejects a misspelled engine', () => {
    vi.stubEnv('PROBLEM_MARKING_ENGINE', undefined);
    expect(markingEngine()).toBe('rag');
    vi.stubEnv('PROBLEM_MARKING_ENGINE', 'agent');
    expect(markingEngine()).toBe('agent');
    vi.stubEnv('PROBLEM_MARKING_ENGINE', 'agant');
    expect(() => markingEngine()).toThrow('INVALID_MARKING_ENGINE');
  });
  it('accepts a recommended method without inventing a prerequisite assignment', () => {
    const result = AgentMarkResultSchema.parse(base);
    expect(result.assignments).toEqual([]);
    expect(() => validateAgentEvidence(result, context, bundle)).not.toThrow();
  });
  it.each(['document_quote', 'problem_quote'] as const)(
    'rejects fabricated %s',
    field => {
      const result = AgentMarkResultSchema.parse(base);
      result.methods[0].evidence[field] = 'This quotation never existed.';
      expect(() => validateAgentEvidence(result, context, bundle)).toThrow(
        /EVIDENCE/
      );
    }
  );
  it('rejects another subject, an invented key, and evidence from another part', () => {
    expect(() =>
      validateAgentEvidence(
        AgentMarkResultSchema.parse(base),
        { ...context, subject_key: 'math' },
        bundle
      )
    ).toThrow('INVALID_MARK_KEY');
    const r = AgentMarkResultSchema.parse(base);
    r.methods[0].mark_key = 'physics.skill.invented';
    expect(() => validateAgentEvidence(r, context, bundle)).toThrow(
      'INVALID_MARK_KEY'
    );
    const other = AgentMarkResultSchema.parse(base);
    other.methods[0].part_index = 2;
    expect(() =>
      validateAgentEvidence(other, { ...context, part_indexes: [1, 2] }, bundle)
    ).toThrow('EVIDENCE_PART_MISMATCH');
  });
  it('rejects duplicate preferences, invalid parts, and empty pseudo-success', () => {
    const r = AgentMarkResultSchema.parse(base);
    r.methods.push({ ...r.methods[0], preference: 'alternative' });
    expect(() => validateAgentEvidence(r, context, bundle)).toThrow(
      'DUPLICATE_MARK_RESULT'
    );
    expect(() =>
      validateAgentEvidence(
        AgentMarkResultSchema.parse(base),
        { ...context, part_indexes: [] },
        bundle
      )
    ).toThrow('INVALID_PART_INDEX');
    expect(() =>
      validateAgentEvidence(
        { assignments: [], methods: [], unresolved: [] },
        context,
        bundle
      )
    ).toThrow('EMPTY_MARK_RESULT');
  });
});
