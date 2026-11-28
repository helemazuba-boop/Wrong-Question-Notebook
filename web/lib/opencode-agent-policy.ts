import { z } from 'zod';

export interface OpenCodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export function parseOpenCodeModel(value: string): OpenCodeModelRef {
  const match = /^([^/\s#]+)\/([^\s#]+)(?:#([^\s/#]+))?$/.exec(value);
  if (!match) throw new Error('Model must be provider/model#variant');
  return {
    providerID: match[1],
    id: match[2],
    ...(match[3] && match[3] !== 'default' ? { variant: match[3] } : {}),
  };
}

export function modelSelector(ref: OpenCodeModelRef): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`;
}

const positive = (max: number) => z.number().int().positive().max(max);
export const OpenCodeBudgetSchema = z
  .object({
    maxInputTokens: positive(2_000_000),
    maxOutputTokens: positive(32_768),
    maxTotalTokens: positive(10_000_000),
    maxProviderRequests: positive(64),
    maxSteps: positive(32),
    maxDurationMs: positive(30 * 60_000),
    maxFallbacksPer24Hours: positive(10),
    maxUserTokensPer24Hours: positive(100_000_000),
    cooldownMs: positive(24 * 60 * 60_000),
    quotaGroups: z.record(z.string(), z.string().min(1).max(128)),
  })
  .strict()
  .superRefine((limits, ctx) => {
    if (
      limits.maxTotalTokens <
      limits.maxInputTokens + limits.maxOutputTokens
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Task budget must cover one bounded request',
      });
    }
    if (limits.maxUserTokensPer24Hours < limits.maxTotalTokens) {
      ctx.addIssue({
        code: 'custom',
        message: 'User budget must cover one task',
      });
    }
  });
export type OpenCodeBudget = z.infer<typeof OpenCodeBudgetSchema>;

export interface OpenCodeModelPolicy {
  primary: OpenCodeModelRef;
  fallback?: OpenCodeModelRef;
  enabled: boolean;
  limits?: OpenCodeBudget;
}

export const OpenCodeModelConfigurationSchema = z
  .object({
    model: z.string().trim().min(1),
    fallbackModel: z.string().trim().min(1).optional(),
    fallbackEnabled: z.boolean().optional(),
    fallbackPolicy: OpenCodeBudgetSchema.optional(),
  })
  .strict();

export function parseOpenCodeModelPolicy(raw: unknown): OpenCodeModelPolicy {
  const config = OpenCodeModelConfigurationSchema.parse(raw);
  const primary = parseOpenCodeModel(config.model);
  const fallback = config.fallbackModel
    ? parseOpenCodeModel(config.fallbackModel)
    : undefined;
  if (fallback && modelSelector(primary) === modelSelector(fallback))
    throw new Error('Primary and fallback must differ');
  const enabled = config.fallbackEnabled === true;
  if (enabled && (!fallback || !config.fallbackPolicy))
    throw new Error('Fallback requires a model and explicit budgets');
  if (
    enabled &&
    (!config.fallbackPolicy!.quotaGroups[modelSelector(primary)] ||
      !config.fallbackPolicy!.quotaGroups[modelSelector(fallback!)])
  )
    throw new Error('Fallback requires explicit quota groups');
  return { primary, fallback, enabled, limits: config.fallbackPolicy };
}

export type OpenCodeProviderFailure =
  'rate_limited' | 'quota_exhausted' | 'unavailable' | 'ineligible';

/** Only provider-origin errors reach this classifier. Local 429 is never routed here. */
export function classifyOpenCodeProviderFailure(
  status: number,
  code: string
): OpenCodeProviderFailure {
  const normalized = code.toLowerCase();
  if (
    status === 402 ||
    [
      'insufficient_quota',
      'insufficient_balance',
      'quota_exceeded',
      'credit_balance_too_low',
      'balance_not_enough',
    ].includes(normalized)
  )
    return 'quota_exhausted';
  if (status === 429) return 'rate_limited';
  if ([503, 529].includes(status)) return 'unavailable';
  return 'ineligible';
}
