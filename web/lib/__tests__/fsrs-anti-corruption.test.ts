import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculatePreparedProjection } from '@/lib/fsrs/projector';
import { FSRS_BASELINE_PARAMETERS } from '@/lib/fsrs/parameters';
import type {
  PreparedProjection,
  PreparedProjectionEvent,
} from '@/lib/fsrs/projector-contract';

// FSRS reads ONLY the effective human-final Rating stream. Problem Marks,
// retrieval candidates, Insights, ideas, causes, machine correctness, and LLM
// summaries must never leak into scheduling. These tests pin that boundary:
// identical Rating timelines yield identical cards/dues regardless of Marks,
// and the projection contract structurally refuses any Marks payload.

const PARAMETER_ID = 'f5000000-0000-4000-8000-000000000001';

function reviewEvent(input: {
  eventId: string;
  occurrenceId: string;
  rating: 'Again' | 'Hard' | 'Good' | 'Easy';
  reviewedAt: string;
}): PreparedProjectionEvent {
  return {
    event_id: input.eventId,
    review_occurrence_id: input.occurrenceId,
    event_kind: 'review',
    human_rating: input.rating,
    effective_review_at: input.reviewedAt,
    received_at: input.reviewedAt,
    parameter_set_id: PARAMETER_ID,
    parameter_stable_key: 'default-v1',
    parameters: {
      ...FSRS_BASELINE_PARAMETERS,
      w: [...FSRS_BASELINE_PARAMETERS.w],
      learning_steps: [...FSRS_BASELINE_PARAMETERS.learning_steps],
      relearning_steps: [...FSRS_BASELINE_PARAMETERS.relearning_steps],
    },
    include_in_sm2: true,
  };
}

// One fixed human-final Rating timeline reused for both the "no Marks" and the
// "Knowledge+Skill Marks" problems.
function ratingTimeline(): PreparedProjectionEvent[] {
  return [
    reviewEvent({
      eventId: 'e1000000-0000-4000-8000-000000000001',
      occurrenceId: 'e2000000-0000-4000-8000-000000000001',
      rating: 'Good',
      reviewedAt: '2026-08-01T08:00:00Z',
    }),
    reviewEvent({
      eventId: 'e1000000-0000-4000-8000-000000000002',
      occurrenceId: 'e2000000-0000-4000-8000-000000000002',
      rating: 'Again',
      reviewedAt: '2026-08-02T09:30:00Z',
    }),
    reviewEvent({
      eventId: 'e1000000-0000-4000-8000-000000000003',
      occurrenceId: 'e2000000-0000-4000-8000-000000000003',
      rating: 'Easy',
      reviewedAt: '2026-08-05T18:45:00Z',
    }),
  ];
}

function preparedFor(problemId: string): PreparedProjection {
  const events = ratingTimeline();
  return {
    run_id: '77000000-0000-4000-8000-000000000001',
    user_id: '11000000-0000-4000-8000-000000000001',
    problem_id: problemId,
    lease_token: '88000000-0000-4000-8000-000000000001',
    authority_mode: 'fsrs',
    base_projection_revision: 0,
    timeline_event_count: events.length,
    timeline_fingerprint: 'a'.repeat(64),
    events,
    sm2_baseline: null,
  };
}

const PROBLEM_WITHOUT_MARKS = '33000000-0000-4000-8000-00000000000a';
const PROBLEM_WITH_MARKS = '33000000-0000-4000-8000-00000000000b';

describe('FSRS anti-corruption boundary', () => {
  it('produces an identical card, due, and applications for identical Rating timelines regardless of Marks', () => {
    const withoutMarks = calculatePreparedProjection(
      preparedFor(PROBLEM_WITHOUT_MARKS)
    );
    const withMarks = calculatePreparedProjection(
      preparedFor(PROBLEM_WITH_MARKS)
    );

    expect(withMarks.fsrsCard).not.toBeNull();
    expect(withMarks.fsrsCard).toEqual(withoutMarks.fsrsCard);
    expect(withMarks.applications).toEqual(withoutMarks.applications);
    expect(withMarks.applications).toHaveLength(3);
    // The due timestamp the learner sees is part of the card; it is identical.
    expect(withMarks.fsrsCard?.due).toEqual(withoutMarks.fsrsCard?.due);
  });

  it('structurally rejects any Marks payload smuggled into the projection input', () => {
    const base = preparedFor(PROBLEM_WITH_MARKS);
    const marksPayload = [
      { mark_key: 'math.knowledge.function', role: 'target' },
      { mark_key: 'math.skill.parameter_separation', role: 'target' },
    ];

    expect(() =>
      calculatePreparedProjection({ ...base, problem_marks: marksPayload })
    ).toThrow();
    expect(() =>
      calculatePreparedProjection({
        ...base,
        skill_candidates: ['math.skill.x'],
      })
    ).toThrow();
    expect(() =>
      calculatePreparedProjection({
        ...base,
        events: [
          {
            ...base.events[0],
            insights: { weak: ['math.knowledge.function'] },
          },
          ...base.events.slice(1),
        ],
      })
    ).toThrow();
  });
});

// Dependency guard: nothing under lib/fsrs may import from the Marks / RAG /
// retrieval / attribution / radar subsystems. FSRS stays a pure function of the
// Rating stream only if those modules cannot even be referenced here.
describe('FSRS dependency guard', () => {
  const fsrsDir = fileURLToPath(new URL('../fsrs', import.meta.url));
  const FORBIDDEN_SEGMENTS = new Set([
    'problem-marks',
    'retrieval',
    'rag',
    'attribution',
    'radar',
  ]);
  const IMPORT_SPECIFIER =
    /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(entry => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return entry.endsWith('.ts') ? [path] : [];
    });
  }

  it('no lib/fsrs module imports Marks, retrieval, RAG, attribution, or radar', () => {
    const files = sourceFiles(fsrsDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? match[2];
        if (!specifier) continue;
        const segments = specifier.toLowerCase().split(/[\\/]/);
        if (segments.some(segment => FORBIDDEN_SEGMENTS.has(segment))) {
          offenders.push({ file, specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no lib/fsrs module reads the problem_marks table', () => {
    const files = sourceFiles(fsrsDir);
    const offenders = files.filter(file =>
      readFileSync(file, 'utf8').includes("from('problem_marks')")
    );
    expect(offenders).toEqual([]);
  });
});
