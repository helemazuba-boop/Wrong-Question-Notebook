import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import { loadOnboardingStatus } from '@/lib/onboarding';
import { z } from 'zod';
async function status() {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  try {
    return NextResponse.json({
      data: await loadOnboardingStatus(supabase, user.id),
    });
  } catch {
    return NextResponse.json(
      { error: 'Onboarding status unavailable' },
      { status: 503 }
    );
  }
}
async function choose(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const parsed = z
    .object({ scenario: z.enum(['problems', 'notes', 'words']) })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid scenario' }, { status: 400 });
  const { error } = await (supabase as any)
    .from('user_profiles')
    .update({ onboarding_scenario: parsed.data.scenario })
    .eq('id', user.id);
  return error
    ? NextResponse.json({ error: 'Scenario save failed' }, { status: 503 })
    : status();
}
export const GET = withSecurity(status, { rateLimitType: 'readOnly' });
export const POST = withSecurity(choose, { rateLimitType: 'api' });
