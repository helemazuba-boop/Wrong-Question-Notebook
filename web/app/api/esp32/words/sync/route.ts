import { createLegacyControlUpgradeRequired } from '@/lib/device-control-v3';

// Word content/session synchronization moved to the versioned v3 endpoints.
// Returning an explicit terminal error prevents old devices from silently
// mixing timestamp cursors with the v3 manifest/session model.
export function GET(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}
