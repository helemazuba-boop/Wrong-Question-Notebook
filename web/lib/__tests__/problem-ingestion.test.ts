import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  INGESTION_REGION_ROLES,
  normalizeProblemIngestionDocument,
  parseProblemIngestion,
  problemCandidatesFromIngestion,
  ProblemIngestionDocumentSchema,
  stripProblemIngestionProvenance,
} from '@/lib/problem-ingestion';
import { PROBLEM_TYPE_VALUES } from '@/lib/schemas';

const standalonePromptFiles = ['PROMPT.en.md', 'PROMPT.zh-CN.md'] as const;

function readStandalonePrompt(
  fileName: (typeof standalonePromptFiles)[number]
) {
  return readFileSync(
    new URL(
      `../../contracts/problem-ingestion-v1/${fileName}`,
      import.meta.url
    ),
    'utf8'
  );
}

function parsePromptExample(prompt: string): unknown {
  const example = prompt.match(/```json\s*([\s\S]*?)\s*```/);
  if (!example)
    throw new Error('standalone prompt is missing its JSON example');
  return JSON.parse(example[1]);
}

const document = {
  schema_version: 'wqn.problem-ingestion.v1' as const,
  status: 'complete' as const,
  pages: [
    {
      page_id: 'page-1',
      image_index: 0,
      source_asset_id: null,
      coordinate_space: 'normalized_0_1' as const,
      source_width: null,
      source_height: null,
      provider_width: null,
      provider_height: null,
      rotation_degrees: null,
    },
  ],
  regions: [
    {
      region_id: 'question-region',
      page_id: 'page-1',
      role: 'question' as const,
      polygon: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.8 },
        { x: 0.1, y: 0.8 },
      ],
      text: 'Find x.',
      confidence: 0.95,
    },
    {
      region_id: 'diagram-region',
      page_id: 'page-1',
      role: 'figure' as const,
      polygon: [
        { x: 0.2, y: 0.3 },
        { x: 0.6, y: 0.3 },
        { x: 0.6, y: 0.6 },
        { x: 0.2, y: 0.6 },
      ],
      text: null,
      confidence: 0.9,
    },
  ],
  questions: [
    {
      question_id: 'question-1',
      number_label: '8',
      title: 'Linear Equation',
      shared_stem: [
        { kind: 'text' as const, value: 'Given ' },
        { kind: 'math_inline' as const, value: 'x+1=2' },
        { kind: 'text' as const, value: ', answer the question.' },
      ],
      parts: [
        {
          part_id: 'part-1-1',
          index: 1,
          label: null,
          type: 'fill_blank' as const,
          content: [{ kind: 'text' as const, value: 'Find x.' }],
          full_marks: null,
          choices: [],
          reference_answer: null,
          region_ids: ['question-region'],
          visual_region_ids: ['diagram-region'],
          confidence: 0.95,
          warnings: [],
        },
      ],
      region_ids: ['question-region'],
      visual_region_ids: ['diagram-region'],
      student_work: [
        {
          work_id: 'work-1',
          part_id: 'part-1-1',
          kind: 'working' as const,
          content: [{ kind: 'math_block' as const, value: 'x+1=2\\\\x=1' }],
          region_ids: ['question-region'],
          confidence: 0.9,
        },
      ],
      suggested_tags: ['algebra'],
      confidence: 0.95,
      incomplete: false,
      warnings: [],
    },
  ],
  warnings: [],
};

describe('Problem Ingestion v1', () => {
  it.each(standalonePromptFiles)(
    'ships a self-contained, schema-valid %s import prompt',
    fileName => {
      const prompt = readStandalonePrompt(fileName);
      expect(
        ProblemIngestionDocumentSchema.parse(parsePromptExample(prompt))
          .schema_version
      ).toBe('wqn.problem-ingestion.v1');
      for (const role of INGESTION_REGION_ROLES) {
        expect(prompt).toContain(`\`${role}\``);
      }
      for (const type of PROBLEM_TYPE_VALUES) {
        expect(prompt).toContain(`\`${type}\``);
      }
      for (const kind of ['text', 'math_inline', 'math_block']) {
        expect(prompt).toContain(`\`${kind}\``);
      }
    }
  );

  it('parses the versioned provider-neutral document', () => {
    expect(ProblemIngestionDocumentSchema.parse(document)).toEqual(document);
    expect(parseProblemIngestion(JSON.stringify(document)).ok).toBe(true);
  });

  it('keeps student working out of Problem type and answer data', () => {
    const [candidate] = problemCandidatesFromIngestion(document);
    expect(candidate.parts[0].type).toBe('fill_blank');
    expect(candidate.parts[0].answer_hint).toBeNull();
    expect(candidate.student_work_count).toBe(1);
    expect(candidate.suggest_image_asset).toBe(true);
    expect(candidate.visual_region_ids).toEqual(['diagram-region']);
    expect(candidate.content).toBe('Given $x+1=2$, answer the question.');
    expect(candidate.confidence.warnings[0]).toContain(
      'Student handwriting was preserved'
    );
  });

  it('uses authoritative image geometry and degrades unknown references', () => {
    const normalized = normalizeProblemIngestionDocument(
      {
        ...document,
        regions: [
          ...document.regions,
          {
            ...document.regions[0],
            region_id: 'bad-region',
            page_id: 'page-99',
          },
        ],
      },
      [
        {
          image_index: 0,
          source_width: 1600,
          source_height: 2400,
          provider_width: 1200,
          provider_height: 1800,
        },
      ]
    );
    expect(normalized.pages[0]).toMatchObject({
      source_width: 1600,
      provider_width: 1200,
    });
    expect(normalized.status).toBe('partial');
    expect(
      normalized.regions.some(region => region.region_id === 'bad-region')
    ).toBe(false);
    expect(normalized.warnings[0]).toContain('unknown page reference');
  });

  it('rejects null where the contract requires an empty collection', () => {
    const parsed = ProblemIngestionDocumentSchema.safeParse({
      ...document,
      questions: [{ ...document.questions[0], student_work: null }],
    });
    expect(parsed.success).toBe(false);
  });

  it('does not copy private ingestion references to another Problem owner', () => {
    expect(
      stripProblemIngestionProvenance({
        year: 2024,
        ingestion_id: 'private-id',
        ingestion_schema_version: 'wqn.problem-ingestion.v1',
        ingestion_question_id: 'question-1',
        source_region_ids: ['region-1'],
        visual_region_ids: [],
      })
    ).toEqual({ year: 2024 });
  });
});
