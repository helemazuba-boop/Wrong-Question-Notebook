import { NextResponse } from 'next/server';
import { createClient } from './server';
import { getAuthenticatedPrincipal } from './auth-principal';

export async function requireUser() {
  const supabase = await createClient();
  const { user, error } = await getAuthenticatedPrincipal(supabase);
  if (error || !user) {
    return { user: null, supabase, error: error ?? new Error('Unauthorised') };
  }
  return { user, supabase, error: null };
}

export function unauthorised() {
  return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
}
