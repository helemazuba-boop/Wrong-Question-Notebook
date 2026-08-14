import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/lib/database.types';

const ChallengeIdSchema = z.uuid();
const ChallengeTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

export type McpInitialIdeaChallengePreview = {
  challenge_id: string;
  problem_id: string;
  problem_title: string;
  exact_text: string;
  exact_text_hash: string;
  expires_at: string;
};

export type McpInitialIdeaConfirmation = {
  challenge_id: string;
  problem_id: string;
  revision_id: string;
  revision: number;
  revision_kind: 'set';
  idea: string;
  channel_source: 'mcp';
  idea_origin: 'user_confirmed_external';
  replayed: boolean;
};

type InitialIdeaClient = SupabaseClient<Database>;

export function parseMcpInitialIdeaChallengeParams(
  challengeId: string,
  challengeToken: string
): { challengeId: string; challengeToken: string } {
  return {
    challengeId: ChallengeIdSchema.parse(challengeId),
    challengeToken: ChallengeTokenSchema.parse(challengeToken),
  };
}

export async function readMcpInitialIdeaChallenge(
  serviceClient: InitialIdeaClient,
  userId: string,
  challengeId: string,
  challengeTokenHash: string
): Promise<McpInitialIdeaChallengePreview | null> {
  const { data, error } = await serviceClient
    .from('problem_initial_idea_mcp_challenges')
    .select(
      'id, problem_id, proposed_idea, exact_text_hash, expires_at, consumed_at, challenge_token_hash, problems!inner(title)'
    )
    .eq('id', challengeId)
    .eq('user_id', userId)
    .eq('challenge_token_hash', challengeTokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read MCP idea challenge: ${error.message}`);
  }
  if (!data || data.consumed_at || Date.parse(data.expires_at) <= Date.now()) {
    return null;
  }

  const problemRelation = data.problems as unknown as
    { title: string } | Array<{ title: string }>;
  const problemTitle = Array.isArray(problemRelation)
    ? problemRelation[0]?.title
    : problemRelation?.title;
  if (!problemTitle) {
    throw new Error('MCP idea challenge is missing its Problem');
  }

  return {
    challenge_id: data.id,
    problem_id: data.problem_id,
    problem_title: problemTitle,
    exact_text: data.proposed_idea,
    exact_text_hash: data.exact_text_hash,
    expires_at: data.expires_at,
  };
}

export async function confirmMcpInitialIdeaChallenge(
  authenticatedClient: InitialIdeaClient,
  challengeId: string,
  challengeToken: string
): Promise<McpInitialIdeaConfirmation> {
  const { data, error } = await authenticatedClient.rpc(
    'confirm_mcp_problem_initial_idea',
    {
      p_challenge_id: challengeId,
      p_challenge_token: challengeToken,
    }
  );

  if (error) {
    throw new Error(`Failed to confirm MCP initial idea: ${error.message}`);
  }

  return z
    .object({
      challenge_id: z.uuid(),
      problem_id: z.uuid(),
      revision_id: z.uuid(),
      revision: z.number().int().positive(),
      revision_kind: z.literal('set'),
      idea: z.string().min(1),
      channel_source: z.literal('mcp'),
      idea_origin: z.literal('user_confirmed_external'),
      replayed: z.boolean(),
    })
    .parse(data);
}
