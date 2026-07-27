import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import {
  createApiErrorResponse,
  createApiSuccessResponse,
} from '@/lib/common-utils';
import { API_TOKEN_PREFIX, hashApiToken } from '@/lib/api-token';

// MCP personal access token management (cookie-session authenticated).
// Creation goes through the service role so plaintext generation and hashing
// never leave the server; the plaintext is returned exactly once.

const MAX_ACTIVE_TOKENS = 5;

const CreateTokenSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export async function GET() {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();

  const { data, error } = await supabase
    .from('user_api_tokens')
    .select('id, name, created_at, last_used_at, revoked_at')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json(
      createApiErrorResponse('Failed to load tokens', 500),
      { status: 500 }
    );
  }
  return NextResponse.json(createApiSuccessResponse({ tokens: data ?? [] }));
}

export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return unauthorised();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(createApiErrorResponse('Invalid JSON', 400), {
      status: 400,
    });
  }
  const parsed = CreateTokenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      createApiErrorResponse('Token name must be 1-60 characters', 400),
      { status: 400 }
    );
  }

  const svc = createServiceClient();
  const { count, error: countError } = await svc
    .from('user_api_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('revoked_at', null);
  if (countError) {
    return NextResponse.json(
      createApiErrorResponse('Failed to check token quota', 500),
      { status: 500 }
    );
  }
  if ((count ?? 0) >= MAX_ACTIVE_TOKENS) {
    return NextResponse.json(
      createApiErrorResponse(
        `At most ${MAX_ACTIVE_TOKENS} active tokens are allowed`,
        403
      ),
      { status: 403 }
    );
  }

  const plaintext = `${API_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const { data, error } = await svc
    .from('user_api_tokens')
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      token_hash: hashApiToken(plaintext),
    })
    .select('id, name, created_at')
    .single();

  if (error || !data) {
    return NextResponse.json(
      createApiErrorResponse('Failed to create token', 500),
      { status: 500 }
    );
  }

  // The plaintext appears in this response only; it is never persisted.
  return NextResponse.json(
    createApiSuccessResponse({ token: data, plaintext }),
    { status: 201 }
  );
}
