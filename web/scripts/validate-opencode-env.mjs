#!/usr/bin/env node
import fs from 'node:fs';
import { parseOpenCodeModelPolicy } from '../lib/opencode-agent-policy.ts';

// stdin carries values so credentials never appear in process arguments.
try {
  const text = fs.readFileSync(0, 'utf8');
  let env;
  if (process.argv.includes('--nul')) {
    const pairs = text.split('\0');
    env = {};
    for (let i = 0; i + 1 < pairs.length; i += 2) env[pairs[i]] = pairs[i + 1];
  } else env = JSON.parse(text);
  for (const old of ['WQN_OPENCODE_PROVIDER_ID', 'WQN_OPENCODE_MODEL_ID']) {
    if (Object.hasOwn(env, old))
      throw new Error(`Remove ${old}; configure WQN_OPENCODE_MODEL`);
  }
  const mapped = env.WQN_OPENCODE_USER_BINDINGS_JSON
    ? JSON.parse(env.WQN_OPENCODE_USER_BINDINGS_JSON)
    : {};
  if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped))
    throw new Error('Invalid OpenCode binding map');
  const configs = Object.values(mapped);
  for (const binding of configs) {
    if (
      !binding ||
      typeof binding !== 'object' ||
      Object.keys(binding).some(
        k =>
          ![
            'baseUrl',
            'directory',
            'username',
            'password',
            'agent',
            'model',
            'fallbackModel',
            'fallbackEnabled',
            'fallbackPolicy',
          ].includes(k)
      )
    )
      throw new Error('Invalid or removed OpenCode binding fields');
    if (
      typeof binding.baseUrl !== 'string' ||
      !/^https?:\/\//i.test(binding.baseUrl) ||
      typeof binding.directory !== 'string' ||
      !binding.directory.trim() ||
      ['username', 'password', 'agent'].some(
        key => binding[key] !== undefined && typeof binding[key] !== 'string'
      )
    )
      throw new Error('Invalid OpenCode binding location');
    parseOpenCodeModelPolicy({
      model: binding.model,
      fallbackModel: binding.fallbackModel,
      fallbackEnabled: binding.fallbackEnabled,
      fallbackPolicy: binding.fallbackPolicy,
    });
    if (
      binding.fallbackEnabled &&
      (env.WQN_OPENCODE_CONTROL_SECRET?.length ?? 0) < 32
    )
      throw new Error('OpenCode control secret is required');
  }
  if (env.WQN_OPENCODE_SERVER_URL) {
    if (
      env.WQN_OPENCODE_FALLBACK_ENABLED &&
      !['true', 'false'].includes(env.WQN_OPENCODE_FALLBACK_ENABLED)
    )
      throw new Error('Invalid OpenCode fallback flag');
    const policy = parseOpenCodeModelPolicy({
      model: env.WQN_OPENCODE_MODEL,
      fallbackModel: env.WQN_OPENCODE_FALLBACK_MODEL || undefined,
      fallbackEnabled: env.WQN_OPENCODE_FALLBACK_ENABLED === 'true',
      fallbackPolicy: env.WQN_OPENCODE_FALLBACK_POLICY_JSON
        ? JSON.parse(env.WQN_OPENCODE_FALLBACK_POLICY_JSON)
        : undefined,
    });
    if (policy.enabled && (env.WQN_OPENCODE_CONTROL_SECRET?.length ?? 0) < 32)
      throw new Error('OpenCode control secret is required');
  }
} catch {
  // Configuration can contain credentials. Never print the offending values
  // or a Zod error that includes its raw input.
  console.error(
    'ERROR: Invalid OpenCode configuration; remove old model keys and supply complete model/budget policy.'
  );
  process.exitCode = 1;
}
