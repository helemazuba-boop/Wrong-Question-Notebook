import { expect, it } from 'vitest';
import {
  classifyOpenCodeProviderFailure,
  parseOpenCodeModel,
  parseOpenCodeModelPolicy,
} from '@/lib/opencode-agent-policy';

it('parses only the first slash and preserves variants and casing', () => {
  expect(parseOpenCodeModel('openrouter/anthropic/Claude#high')).toEqual({
    providerID: 'openrouter',
    id: 'anthropic/Claude',
    variant: 'high',
  });
  for (const value of [
    'model',
    '/model',
    'provider/',
    'p/m#',
    'p/m#x#y',
    'p/m x',
  ])
    expect(() => parseOpenCodeModel(value)).toThrow();
});
it('rejects removed model fields and incomplete fallback policy', () => {
  expect(() =>
    parseOpenCodeModelPolicy({ model: 'p/m', providerId: 'p', modelId: 'm' })
  ).toThrow();
  expect(() =>
    parseOpenCodeModelPolicy({ model: 'p/m', fallbackModel: 'p/m' })
  ).toThrow();
  expect(() =>
    parseOpenCodeModelPolicy({
      model: 'p/m',
      fallbackModel: 'q/m',
      fallbackEnabled: true,
    })
  ).toThrow();
  expect(parseOpenCodeModelPolicy({ model: 'p/m' }).enabled).toBe(false);
});
it.each([
  [429, '', 'rate_limited'],
  [429, 'insufficient_quota', 'quota_exhausted'],
  [402, '', 'quota_exhausted'],
  [403, 'insufficient_balance', 'quota_exhausted'],
  [401, '', 'ineligible'],
  [403, '', 'ineligible'],
  [400, 'invalid_request', 'ineligible'],
  [503, '', 'unavailable'],
  [502, '', 'ineligible'],
])('classifies provider %s/%s as %s', (status, code, result) => {
  expect(
    classifyOpenCodeProviderFailure(status as number, code as string)
  ).toBe(result);
});
