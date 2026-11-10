'use server';

import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/supabase/requireUser';
import { createServiceClient } from '@/lib/supabase-utils';
import { consumeRateLimit } from '@/lib/rate-limit';
import { hashOAuthSecret } from '@/lib/oauth/service';
import { normalizeUserCode } from '@/lib/oauth/device';

// Next Server Actions validate Origin against Host. The session and grant
// are checked again here; displaying a consent page never grants access.
export async function decideDeviceAuthorization(form: FormData): Promise<void> {
  const { user } = await requireUser();
  if (!user) redirect('/oauth/device');
  const limit = consumeRateLimit('oauth-device-decision', user.id, {
    windowMs: 15 * 60 * 1000,
    maxRequests: 20,
  });
  if (!limit.ok) redirect('/oauth/device?result=unavailable');
  const code = normalizeUserCode(String(form.get('user_code') ?? ''));
  const id = String(form.get('authorization_id') ?? '');
  const decision = form.get('decision');
  if (
    !code ||
    !/^[0-9a-f-]{36}$/i.test(id) ||
    !['approve', 'deny'].includes(String(decision)) ||
    (decision === 'approve' && form.get('confirmed') !== 'yes')
  ) {
    redirect('/oauth/device?result=unavailable');
  }
  const { data, error } = await createServiceClient()
    .from('oauth_device_authorizations')
    .update({
      user_id: user.id,
      status: decision === 'approve' ? 'approved' : 'denied',
      decided_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_code_hash', hashOAuthSecret(code))
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();
  if (error || !data) redirect('/oauth/device?result=unavailable');
  redirect(
    `/oauth/device?result=${decision === 'approve' ? 'approved' : 'denied'}&request=${id}`
  );
}
