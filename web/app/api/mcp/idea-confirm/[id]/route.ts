import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  confirmMcpInitialIdeaChallenge,
  parseMcpInitialIdeaChallengeParams,
  readMcpInitialIdeaChallenge,
} from '@/lib/mcp-initial-idea-challenge';
import { revalidateProblemComprehensive } from '@/lib/cache-invalidation';

export const runtime = 'nodejs';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function authenticateChallenge(
  challengeId: string,
  challengeToken: string
) {
  const { user, supabase } = await requireUser();
  if (!user) return { response: unauthorised() } as const;

  let parsed;
  try {
    parsed = parseMcpInitialIdeaChallengeParams(challengeId, challengeToken);
  } catch {
    return {
      response: errorResponse('Invalid confirmation link', 400),
    } as const;
  }

  const preview = await readMcpInitialIdeaChallenge(
    createServiceClient(),
    user.id,
    parsed.challengeId,
    sha256Hex(parsed.challengeToken)
  );
  if (!preview) {
    return {
      response: errorResponse(
        'Confirmation link is invalid, expired, or used',
        404
      ),
    } as const;
  }

  return {
    user,
    supabase,
    preview,
    challengeId: parsed.challengeId,
    challengeToken: parsed.challengeToken,
  } as const;
}

const ChallengeTokenBodySchema = z.object({
  token: z.string(),
});

async function readChallengeToken(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: errorResponse('Invalid JSON', 400) } as const;
  }
  const parsed = ChallengeTokenBodySchema.safeParse(body);
  if (!parsed.success) {
    return { response: errorResponse('Invalid confirmation', 400) } as const;
  }
  return { token: parsed.data.token } as const;
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await readChallengeToken(req);
  if ('response' in body) return body.response;

  const { id } = await params;
  try {
    const result = await authenticateChallenge(id, body.token);
    if ('response' in result) return result.response;
    return NextResponse.json({ data: result.preview });
  } catch (error) {
    console.error('Failed to load MCP initial idea challenge:', error);
    return errorResponse('Failed to load confirmation', 500);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const body = await readChallengeToken(req);
  if ('response' in body) return body.response;

  const { id } = await params;
  try {
    const result = await authenticateChallenge(id, body.token);
    if ('response' in result) return result.response;

    const confirmed = await confirmMcpInitialIdeaChallenge(
      result.supabase,
      result.challengeId,
      result.challengeToken
    );

    const { data: problem } = await result.supabase
      .from('problems')
      .select('subject_id')
      .eq('id', confirmed.problem_id)
      .eq('user_id', result.user.id)
      .single();
    if (problem) {
      await revalidateProblemComprehensive(
        confirmed.problem_id,
        problem.subject_id,
        result.user.id
      );
    }

    return NextResponse.json({ data: confirmed });
  } catch (error) {
    console.error('Failed to confirm MCP initial idea challenge:', error);
    return errorResponse('Failed to confirm initial idea', 500);
  }
}
