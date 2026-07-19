import { createLegacyControlUpgradeRequired } from '@/lib/device-control-v3';

export function GET(req: Request) {
  return createLegacyControlUpgradeRequired(req);
}
