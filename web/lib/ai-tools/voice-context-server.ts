import 'server-only';
import type { McpToolContext } from '@/lib/mcp/tool-registry';
import { listAuthorizedNotebooks } from '@/lib/notebooks';
import { validTimezone, type VoiceContext } from './voice-context';
export async function loadVoiceContext(
  ctx: Pick<McpToolContext, 'supabase' | 'userId'>,
  now = new Date().toISOString()
): Promise<VoiceContext> {
  const [profile, notebooks] = await Promise.allSettled([
    Promise.resolve().then(() =>
      ctx.supabase
        .from('user_profiles')
        .select('timezone,is_active')
        .eq('id', ctx.userId)
        .maybeSingle()
    ),
    Promise.resolve().then(() => listAuthorizedNotebooks(ctx)),
  ]);
  const rows =
    notebooks.status === 'fulfilled'
      ? notebooks.value.notebooks.filter(n => n.permissions.can_create)
      : [];
  if (profile.status === 'fulfilled' && profile.value.data?.is_active === false)
    throw new Error('Account disabled');
  return {
    now,
    timezone_available:
      profile.status === 'fulfilled' &&
      !profile.value.error &&
      Boolean(profile.value.data),
    timezone: validTimezone(
      profile.status === 'fulfilled' ? profile.value.data?.timezone : null
    ),
    notebooks: rows
      .slice(0, 50)
      .map(n => ({ id: n.id, title: n.title, subject_name: n.subject_name })),
    notebooks_available: notebooks.status === 'fulfilled',
    notebooks_truncated: rows.length > 50,
  };
}
