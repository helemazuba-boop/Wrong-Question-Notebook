import { createLegacyControlUpgradeRequired } from '@/lib/device-control-v3';

// M7 is a synchronized v3 cutover. There are no historical users or devices
// to preserve, so the MAC-based browser pairing control plane is deliberately
// unavailable instead of running a long-lived v2/v3 compatibility stack.
export function POST(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}
