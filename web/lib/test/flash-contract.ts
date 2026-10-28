import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { expect } from 'vitest';

export const flashContractRoot = resolve(
  process.cwd(),
  'contracts/flash-realtime-v2'
);
export const flashSchema = JSON.parse(
  readFileSync(
    resolve(flashContractRoot, 'flash-realtime-v2.schema.json'),
    'utf8'
  )
);
export const validateFlashControl = new Ajv2020({
  strict: true,
  allErrors: true,
}).compile(flashSchema);
const ownedTypes = new Set(
  Object.values(
    flashSchema.$defs as Record<
      string,
      { properties?: { type?: { const?: string } } }
    >
  )
    .map(definition => definition.properties?.type?.const)
    .filter(Boolean)
);

// Invoke on actual socket emissions as well as fixtures. Native provider
// passthrough events have their own contract and are deliberately not coerced.
export function assertFlashControl(event: { type?: string }) {
  if (!ownedTypes.has(event.type)) return;
  const valid = validateFlashControl(event);
  expect(validateFlashControl.errors, JSON.stringify(event)).toBeNull();
  expect(valid).toBe(true);
}
