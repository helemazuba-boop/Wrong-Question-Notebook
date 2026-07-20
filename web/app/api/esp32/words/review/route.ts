import { createLegacyControlUpgradeRequired } from '@/lib/device-control-v3';

// W8 retires the device-specific legacy queue and non-idempotent review write.
// Web/AI callers are migrated separately in W7 and do not use this route.
export function GET(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}

export function POST(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}
