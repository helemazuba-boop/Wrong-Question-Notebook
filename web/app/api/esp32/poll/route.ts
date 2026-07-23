import { createLegacyControlUpgradeRequired } from '@/lib/device-control-v3';

// Firmware must use /v3/claim/start + /v3/claim/poll. MAC addresses are never
// accepted as credential-recovery material after the M7 cutover.
export function GET(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}
