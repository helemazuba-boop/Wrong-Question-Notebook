import { type EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { getSafeAuthRedirect } from '@/lib/auth-redirect';
import { createClient } from '@/lib/supabase/server';

function errorRedirect(request: NextRequest, message: string): NextResponse {
  const locale =
    request.nextUrl.searchParams.get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
  const url = new URL(`/${locale}/auth/error`, request.url);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get('code');
  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const redirectPath = getSafeAuthRedirect(params.get('next'));
  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return errorRedirect(request, error.message);
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    if (error) return errorRedirect(request, error.message);
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }

  return errorRedirect(request, 'Missing or expired authentication code');
}
