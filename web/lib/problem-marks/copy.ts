import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';

export interface ProblemMarkCopyMapping {
  source_problem_id: string;
  destination_problem_id: string;
}

export interface ProblemMarkInheritanceResult {
  inherited: number;
  pending: number;
}

export function createProblemMarkCopyMapping(
  sourceProblemId: string
): ProblemMarkCopyMapping {
  return {
    source_problem_id: sourceProblemId,
    destination_problem_id: randomUUID(),
  };
}

export async function inheritProblemMarksBestEffort(
  serviceClient: SupabaseClient<Database>,
  mappings: ProblemMarkCopyMapping[]
): Promise<ProblemMarkInheritanceResult> {
  if (mappings.length === 0) return { inherited: 0, pending: 0 };

  try {
    const { data, error } = await serviceClient.rpc('inherit_problem_marks', {
      p_mappings: mappings as unknown as Json,
    });
    if (error) throw error;

    const result = data as unknown as Record<string, unknown>;
    const inherited = nonNegativeInteger(result.inherited);
    const pending = nonNegativeInteger(result.pending);
    if (inherited + pending !== mappings.length) {
      throw new Error('Problem Mark inheritance response count mismatch');
    }
    return { inherited, pending };
  } catch (error) {
    console.error(
      'Problem Mark inheritance failed; copied Problems remain pending:',
      error
    );
    return { inherited: 0, pending: mappings.length };
  }
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('Invalid Problem Mark inheritance response');
  }
  return number;
}
