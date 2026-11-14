import 'server-only';
import { getAppOrigin } from '@/lib/app-origin';

/** Cookie writes use the configured public origin, never an upstream host. */
export function isTrustedWriteOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  // Preserve non-browser clients that omit Origin; cookie auth still applies.
  if (!origin) return true;
  try {
    return origin === getAppOrigin();
  } catch {
    return false;
  }
}
