import { NextResponse } from 'next/server';
import { requireUser, unauthorised } from '@/lib/supabase/requireUser';
import { withSecurity } from '@/lib/security-middleware';
import { loadOnboardingStatus } from '@/lib/onboarding';
async function complete(req: Request) {
  const { user, supabase } = await requireUser();
  if (!user) return unauthorised();
  const body = await req.json().catch(() => ({}));
  try {
    let field: 'onboarding_dismissed_at' | 'onboarding_completed_at';
    if (body?.dismiss === true) {
      field = 'onboarding_dismissed_at';
    } else {
      const status = await loadOnboardingStatus(supabase, user.id);
      if (
        !status.scenario ||
        !status.hasContainer ||
        !status.hasContent ||
        !status.hasPracticed
      )
        return NextResponse.json(
          { error: 'Onboarding steps incomplete' },
          { status: 409 }
        );
      field = 'onboarding_completed_at';
    }
    const { error } = await (supabase as any)
      .from('user_profiles')
      .update({ [field]: new Date().toISOString() })
      .eq('id', user.id)
      .is(field, null);
    return error
      ? NextResponse.json({ error: 'Onboarding save failed' }, { status: 503 })
      : NextResponse.json({
          data: {
            completed: field === 'onboarding_completed_at',
            dismissed: field === 'onboarding_dismissed_at',
          },
        });
  } catch {
    return NextResponse.json(
      { error: 'Onboarding status unavailable' },
      { status: 503 }
    );
  }
}
export const POST = withSecurity(complete, { rateLimitType: 'api' });
