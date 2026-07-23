import { createLegacyControlUpgradeRequired } from '@/lib/device-control-v3';

// Control-plane synchronization moved to /api/esp32/v3/sync. Version-frozen
// content/media routes remain available behind device Bearer authentication.
export function POST(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}
