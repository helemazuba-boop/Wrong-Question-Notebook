#!/usr/bin/env node
// Per-user FSRS authority cutover driver.
//
// The cutover itself is a single transactional RPC behind an HMAC-guarded
// internal endpoint. This script does the part the server cannot do for you:
// read the current shadow projections, hand the RPC the exact
// (problem_id, projection_revision, timeline_fingerprint) triples it expects,
// and print the result. The RPC re-checks every triple, so a stale read is a
// clean refusal (FSRS_CUTOVER_EXPECTATION_MISMATCH), never a partial cutover.
//
//   cd web
//   node scripts/fsrs-cutover.mjs --domain problem --user <uuid> --dry-run
//   node scripts/fsrs-cutover.mjs --domain problem --user <uuid>
//   node scripts/fsrs-cutover.mjs --domain problem --user <uuid> --cancel <cutover_id>
//
// Reads .env.production from the current directory (or --env-path) for
// PROBLEM_REVIEW_PROJECTION_SECRET, NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SECRET_KEY; process.env fills any gaps. The base URL comes from
// --base-url, then WQN_BASE_URL, then SITE_URL.

import { createHmac } from 'crypto';
import { existsSync, readFileSync } from 'fs';

const DOMAINS = {
  problem: {
    label: 'problem',
    projectionTable: 'fsrs_review_schedule_projection',
    idColumn: 'problem_id',
    jobsTable: 'problem_review_projection_jobs',
    endpoint: '/api/internal/problem-reviews/authority',
    countField: 'problem_count',
    restoredCountField: 'restored_problem_count',
    // The cutover RPC promotes and counts only initialized cards, so a problem
    // that has a projection row but no FSRS card yet must stay out of the
    // payload or the expectation count can never match.
    extraQuery: { card_initialized: 'eq.true' },
  },
  word: {
    label: 'word',
    projectionTable: 'word_progress_fsrs_projection',
    idColumn: 'word_entry_id',
    jobsTable: 'word_progress_projection_jobs',
    endpoint: '/api/internal/word-reviews/authority',
    countField: 'word_count',
    restoredCountField: 'restored_word_count',
    // The cutover RPC only promotes initialized cards and counts them for its
    // expectation check, so a word that was only ever skipped (no card yet)
    // must stay out of the payload.
    extraQuery: { card_initialized: 'eq.true' },
  },
};

const USAGE = `Usage:
  node scripts/fsrs-cutover.mjs --domain <${Object.keys(DOMAINS).join('|')}> --user <uuid> [options]

Options:
  --domain <name>     projection family to cut over (required)
  --user <uuid>       target user id (required)
  --cancel <uuid>     cancel an active cutover instead of starting one
  --dry-run           print the payload instead of POSTing it
  --base-url <url>    deployment origin, e.g. https://wqn.helema.cn
  --env-path <path>   env file to read (default ./.env.production)
  --help              show this message`;

function parseArgs(argv) {
  const options = {
    domain: null,
    user: null,
    cancel: null,
    dryRun: false,
    baseUrl: null,
    envFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      index += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--domain') {
      options.domain = takeValue();
    } else if (arg === '--user') {
      options.user = takeValue();
    } else if (arg === '--cancel') {
      options.cancel = takeValue();
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--base-url') {
      options.baseUrl = takeValue();
    } else if (arg === '--env-path') {
      options.envFile = takeValue();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function loadEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith('#')) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readConfig(options) {
  const envFile = options.envFile || './.env.production';
  const fileValues = loadEnvFile(envFile);
  const lookup = name => {
    const value = process.env[name] || fileValues[name];
    return value && value.trim() ? value.trim() : null;
  };

  const missing = [];
  const secret = lookup('PROBLEM_REVIEW_PROJECTION_SECRET');
  if (!secret) missing.push(`PROBLEM_REVIEW_PROJECTION_SECRET (${envFile})`);
  const supabaseUrl = (lookup('NEXT_PUBLIC_SUPABASE_URL') || '').replace(
    /\/+$/,
    ''
  );
  if (!supabaseUrl) missing.push(`NEXT_PUBLIC_SUPABASE_URL (${envFile})`);
  const serviceKey = lookup('SUPABASE_SECRET_KEY');
  if (!serviceKey) missing.push(`SUPABASE_SECRET_KEY (${envFile})`);
  const baseUrl = (
    options.baseUrl ||
    lookup('WQN_BASE_URL') ||
    lookup('SITE_URL') ||
    ''
  ).replace(/\/+$/, '');
  if (!baseUrl) missing.push('--base-url (or WQN_BASE_URL / SITE_URL)');

  if (missing.length > 0) {
    throw new Error(`missing configuration:\n  - ${missing.join('\n  - ')}`);
  }
  return { secret, supabaseUrl, serviceKey, baseUrl, envFile };
}

async function fetchJson(url, headers, options = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${text.slice(0, 400)}`
    );
  }
  // PostgREST reports an exact count only in the Content-Range header, so a
  // caller that needs a total has to see the response object too.
  return options.includeResponse ? { body, response } : body;
}

// PostgREST caps every response, so page explicitly instead of hoping one
// request covers the user's whole projection set.
async function fetchProjections(config, domain) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(
      `${config.supabaseUrl}/rest/v1/${domain.projectionTable}`
    );
    url.searchParams.set(
      'select',
      `${domain.idColumn},projection_revision,timeline_fingerprint`
    );
    url.searchParams.set('user_id', `eq.${config.userId}`);
    url.searchParams.set('order', `${domain.idColumn}.asc`);
    for (const [key, value] of Object.entries(domain.extraQuery ?? {})) {
      url.searchParams.set(key, value);
    }
    const page = await fetchJson(url.toString(), {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      Range: `${offset}-${offset + pageSize - 1}`,
      'Range-Unit': 'items',
    });
    if (!Array.isArray(page))
      throw new Error('projection query did not return an array');
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

// The Range below asks PostgREST for one row, so the body length can only ever
// be 0 or 1: the real total arrives in the Content-Range header as "0-0/42".
async function fetchDirtyJobCount(config, domain) {
  const url = new URL(`${config.supabaseUrl}/rest/v1/${domain.jobsTable}`);
  url.searchParams.set('select', 'user_id');
  url.searchParams.set('user_id', `eq.${config.userId}`);
  const { body, response } = await fetchJson(
    url.toString(),
    {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
    { includeResponse: true }
  );
  const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  return total ? Number(total[1]) : Array.isArray(body) ? body.length : 0;
}

function sign(secret, timestamp, body) {
  return createHmac('sha256', secret)
    .update(timestamp)
    .update('\n')
    .update(body)
    .digest('hex');
}

async function post(config, domain, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const response = await fetch(`${config.baseUrl}${domain.endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wqn-timestamp': timestamp,
      'x-wqn-signature': sign(config.secret, timestamp, body),
    },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const code = parsed && parsed.error ? parsed.error : text.slice(0, 400);
    const hint =
      response.status === 401
        ? '\n  (401 means PROBLEM_REVIEW_PROJECTION_SECRET here does not match the value the App container was started with)'
        : '';
    throw new Error(`${response.status} ${code}${hint}`);
  }
  return parsed && parsed.data ? parsed.data : parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.domain) throw new Error('--domain is required');
  const domain = DOMAINS[options.domain];
  if (!domain) {
    throw new Error(
      `unknown domain "${options.domain}" (known: ${Object.keys(DOMAINS).join(', ')})`
    );
  }
  if (!options.user || !/^[0-9a-fA-F-]{36}$/.test(options.user)) {
    throw new Error('--user must be a 36 character uuid');
  }

  const config = readConfig(options);
  config.userId = options.user;
  console.log(
    `[cutover] domain=${options.domain} user=${config.userId} base=${config.baseUrl}`
  );
  console.log(`[cutover] env file: ${config.envFile}`);

  if (options.cancel) {
    const payload = {
      action: 'cancel',
      user_id: config.userId,
      cutover_id: options.cancel,
    };
    if (options.dryRun) {
      console.log('[cutover] dry run, payload:');
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    const result = await post(config, domain, payload);
    console.log('[cutover] cancelled:', JSON.stringify(result));
    console.log(
      `[cutover] restored ${result[domain.restoredCountField]} ${domain.label} schedules to sm2`
    );
    return 0;
  }

  const dirty = await fetchDirtyJobCount(config, domain);
  if (dirty > 0) {
    console.log(
      `[cutover] warning: ${dirty} projection job row(s) still exist for this user; ` +
        'the RPC refuses while any of them is dirty. Run the projector first.'
    );
  }

  const projections = await fetchProjections(config, domain);
  if (projections.length === 0) {
    throw new Error(
      `no ${domain.projectionTable} rows for this user: nothing has been projected yet, ` +
        'so there is no FSRS state to promote'
    );
  }
  const payload = {
    action: 'cutover',
    user_id: config.userId,
    expected_projections: projections.map(row => ({
      [domain.idColumn]: row[domain.idColumn],
      projection_revision: Number(row.projection_revision),
      timeline_fingerprint: row.timeline_fingerprint,
    })),
  };
  console.log(
    `[cutover] ${payload.expected_projections.length} projection(s) ready, ` +
      `revisions ${Math.min(...payload.expected_projections.map(p => p.projection_revision))}..` +
      `${Math.max(...payload.expected_projections.map(p => p.projection_revision))}`
  );

  if (options.dryRun) {
    console.log('[cutover] dry run, payload:');
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const result = await post(config, domain, payload);
  console.log('[cutover] done:', JSON.stringify(result));
  console.log(
    `[cutover] ${result[domain.countField]} ${domain.label} schedule(s) now follow FSRS ` +
      `(authority_mode=${result.authority_mode})`
  );
  console.log(`[cutover] roll back with: --cancel ${result.cutover_id}`);
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(`[cutover] ${error.message}`);
    process.exit(1);
  });
