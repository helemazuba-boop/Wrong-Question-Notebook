import { ENV_VARS } from './constants';
import { validateSupabasePublicEnvironment } from './supabase-config';

export interface SupabaseServerEnvironment {
  url: string;
  publishableKey: string;
  secretKey: string;
}

export function getSupabaseServerEnvironment(): SupabaseServerEnvironment {
  if (typeof window !== 'undefined') {
    throw new Error('Supabase server credentials cannot be read in a browser');
  }
  const publicEnvironment = validateSupabasePublicEnvironment({
    url: process.env[ENV_VARS.SUPABASE_URL],
    publishableKey: process.env[ENV_VARS.SUPABASE_ANON_KEY],
    expectedHost: process.env[ENV_VARS.SUPABASE_EXPECTED_HOST],
    allowedHttpOrigin: process.env.WQN_ALLOW_HTTP_SUPABASE_ORIGIN,
    nodeEnv: process.env.NODE_ENV,
  });
  const secretKey =
    process.env[ENV_VARS.SUPABASE_SECRET_KEY] ||
    process.env[ENV_VARS.SUPABASE_SERVICE_ROLE_KEY];
  if (!secretKey) {
    throw new Error(
      `${ENV_VARS.SUPABASE_SECRET_KEY} or ${ENV_VARS.SUPABASE_SERVICE_ROLE_KEY} must be set`
    );
  }
  if (secretKey === publicEnvironment.publishableKey) {
    throw new Error('Supabase server key must differ from the publishable key');
  }
  return { ...publicEnvironment, secretKey };
}
