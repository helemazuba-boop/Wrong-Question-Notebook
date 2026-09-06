import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractJsonFromPaste,
  INGESTION_REGION_ROLES,
  normalizeProblemIngestionDocument,
  parseProblemIngestion,
  problemCandidatesFromIngestion,
  ProblemIngestionDocumentSchema,
  stripProblemIngestionProvenance,
} from '@/lib/problem-ingestion';
import { PROBLEM_TYPE_VALUES } from '@/lib/schemas';

const standalonePromptFiles = ['PROMPT.en.md', 'PROMPT.zh-CN.md'] as const;
const publicPromptFiles = {
  'PROMPT.en.md': 'problem-ingestion-prompt.en.md',
  'PROMPT.zh-CN.md': 'problem-ingestion-prompt.zh-CN.md',
} as const;

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

function readPublicPrompt(fileName: string) {
  return readFileSync(
    new URL(`../../public/docs/${fileName}`, import.meta.url),
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

describe('paste JSON extraction', () => {
  const jsonText = JSON.stringify(document, null, 2);

  it('parses a bare JSON document', () => {
    expect(parseProblemIngestion(jsonText)).toEqual({
      ok: true,
      data: document,
    });
  });

  it('parses JSON wrapped in prose and a markdown fence', () => {
    const wrapped = `好的，以下是识别结果：\n\`\`\`json\n${jsonText}\n\`\`\`\n如果需要调整请告诉我。`;
    expect(parseProblemIngestion(wrapped)).toEqual({
      ok: true,
      data: document,
    });
  });

  it('parses JSON with surrounding prose and no fence', () => {
    const wrapped = `Here is the extraction:\n\n${jsonText}\n\nLet me know if you need changes.`;
    expect(parseProblemIngestion(wrapped)).toEqual({
      ok: true,
      data: document,
    });
  });

  it('skips smaller JSON snippets embedded in prose', () => {
    const withNoise = `空对象是 {}，空数组是 []。\n\n真实结果：\n${jsonText}`;
    expect(parseProblemIngestion(withNoise)).toEqual({
      ok: true,
      data: document,
    });
  });

  it('respects braces inside JSON strings while scanning', () => {
    const tricky = {
      ...document,
      questions: [
        {
          ...document.questions[0],
          shared_stem: [
            { kind: 'text' as const, value: 'brace } and { inside string' },
          ],
        },
      ],
    };
    const wrapped = `answer:\n${JSON.stringify(tricky, null, 2)}\nend`;
    const parsed = parseProblemIngestion(wrapped);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.questions[0].question_id).toBe('question-1');
    }
  });

  it('reports the v1 schema issue when JSON parses but the shape is wrong', () => {
    const wrong = JSON.stringify({ schema_version: 'x', questions: [] });
    const result = parseProblemIngestion(`说明：\n${wrong}\n以上。`);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'invalid_schema') {
      expect(result.detail).toContain('schema_version');
      expect(result.detail).toContain('wqn.problem-ingestion.v1');
    } else {
      expect.unreachable('expected invalid_schema');
    }
  });

  it('reports no_json when the text contains no JSON at all', () => {
    const result = parseProblemIngestion('第1题选B，第2题选A。');
    expect(result).toEqual({
      ok: false,
      error: 'invalid_json',
      detail: 'No JSON object was found in the pasted text',
    });
  });

  it('reports unparseable_json when JSON-like text is malformed', () => {
    const result = extractJsonFromPaste('结果：\n{"a": 1, "b": [1,2}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unparseable_json');
    } else {
      expect.unreachable('expected failure');
    }
  });
});

describe('public paste-prompt copies', () => {
  it.each(Object.entries(publicPromptFiles))(
    'keeps public/docs/%s identical to the contract prompt',
    (contractFile, publicFile) => {
      expect(readPublicPrompt(publicFile)).toBe(
        readStandalonePrompt(
          contractFile as (typeof standalonePromptFiles)[number]
        )
      );
    }
  );
});
