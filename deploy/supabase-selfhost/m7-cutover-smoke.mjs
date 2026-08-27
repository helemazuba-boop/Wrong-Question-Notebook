import { randomBytes, randomUUID, webcrypto } from "node:crypto";

function requiredOrigin(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const endpoint = new URL(value);
  const origin = endpoint.origin;
  if (value.replace(/\/+$/, "") !== origin) {
    throw new Error(`${name} must be an origin without a path`);
  }
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return origin;
}

const dataBase = requiredOrigin("SUPABASE_PUBLIC_URL");
const wqnBase = requiredOrigin("WQN_BASE_URL");
const confirmedDataBase = process.env.CONFIRM_SUPABASE_PUBLIC_ORIGIN;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (confirmedDataBase !== dataBase) {
  throw new Error(
    `CONFIRM_SUPABASE_PUBLIC_ORIGIN must exactly equal ${dataBase}`,
  );
}
if (!publishableKey) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
}
if (new URL(dataBase).protocol === "http:") {
  console.warn(
    "[m7-smoke] Supabase uses HTTP; continue only over an encrypted private network such as WireGuard",
  );
}

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  return response;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonWithoutLoggingPayload(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON (HTTP ${response.status})`);
  }
}

async function postV3(path, body, authorization) {
  const headers = {
    "Content-Type": "application/json",
    "X-WQN-Protocol": "3",
    "X-WQN-Request-Id": body.request_id,
  };
  if (authorization) headers.Authorization = authorization;
  return request(`${wqnBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const health = await request(`${dataBase}/auth/v1/health`, {
  headers: { apikey: publishableKey },
});
assert(health.ok, `Auth health failed with HTTP ${health.status}`);

const rest = await request(`${dataBase}/rest/v1/`, {
  headers: { apikey: publishableKey },
});
assert(rest.ok, `REST health failed with HTTP ${rest.status}`);

const storage = await request(`${dataBase}/storage/v1/status`, {
  headers: { apikey: publishableKey },
});
assert(storage.ok, `Storage health failed with HTTP ${storage.status}`);

const anonymousKongRoot = await request(`${dataBase}/`);
assert(
  new Set([401, 404]).has(anonymousKongRoot.status),
  `Anonymous Kong root must be hidden (got HTTP ${anonymousKongRoot.status})`,
);
const authenticatedKongRoot = await request(`${dataBase}/`, {
  headers: { apikey: publishableKey },
});
assert(
  new Set([401, 404]).has(authenticatedKongRoot.status),
  `Publishable-key Kong root must be hidden (got HTTP ${authenticatedKongRoot.status})`,
);

const legacyRequestId = `m7_legacy_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
const legacy = await request(`${wqnBase}/api/esp32/poll`, {
  headers: { "X-WQN-Request-Id": legacyRequestId },
});
const legacyBody = await jsonWithoutLoggingPayload(
  legacy,
  "legacy control route",
);
assert(
  legacy.status === 426,
  `legacy control route returned HTTP ${legacy.status}`,
);
assert(
  legacyBody?.error?.code === "UPGRADE_REQUIRED" &&
    legacyBody?.request_id === legacyRequestId,
  "legacy control route did not return the v3 UPGRADE_REQUIRED envelope",
);

const keyPair = await webcrypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"],
);
const publicKey = Buffer.from(
  await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
).toString("base64url");
const runId = randomUUID().replaceAll("-", "").slice(0, 24);
const bootId = `m7_smoke_boot_${runId}`;
const metadata = {
  boot_id: bootId,
  firmware_version: "m7-cutover-smoke",
  capabilities: ["device-control-v3", "ai-sse-v2", "wqn-flash-v2"],
};
const hardwareSuffix = randomBytes(3)
  .toString("hex")
  .toUpperCase()
  .match(/.{2}/g)
  .join(":");

const claimStartBody = {
  ...metadata,
  request_id: `m7_claim_start_${runId}`,
  hardware_id: `02:00:00:${hardwareSuffix}`,
  device_public_key: publicKey,
};
const claimStart = await postV3("/api/esp32/v3/claim/start", claimStartBody);
const claimStartPayload = await jsonWithoutLoggingPayload(
  claimStart,
  "claim/start",
);
assert(
  claimStart.ok && claimStartPayload?.ok === true,
  `claim/start failed with HTTP ${claimStart.status}`,
);
assert(
  typeof claimStartPayload?.data?.claim_id === "string" &&
    /^[0-9]{8}$/.test(claimStartPayload?.data?.display_code ?? ""),
  "claim/start returned an invalid envelope",
);

const claimPoll = await postV3("/api/esp32/v3/claim/poll", {
  ...metadata,
  request_id: `m7_claim_poll_${runId}`,
  claim_id: claimStartPayload.data.claim_id,
});
const claimPollPayload = await jsonWithoutLoggingPayload(
  claimPoll,
  "claim/poll",
);
assert(
  claimPoll.ok && claimPollPayload?.ok === true,
  `claim/poll failed with HTTP ${claimPoll.status}`,
);
assert(
  claimPollPayload?.data?.status === "pending",
  "new claim was not pending",
);

const bootstrapRequestId = `m7_bootstrap_${runId}`;
const unauthenticatedBootstrap = await postV3(
  "/api/esp32/v3/bootstrap",
  {
    ...metadata,
    request_id: bootstrapRequestId,
    config_revision: 0,
    sync_cursor: 0,
  },
  `Bearer ${"0".repeat(64)}`,
);
const bootstrapPayload = await jsonWithoutLoggingPayload(
  unauthenticatedBootstrap,
  "bootstrap authentication",
);
assert(
  unauthenticatedBootstrap.status === 401 &&
    bootstrapPayload?.request_id === bootstrapRequestId &&
    bootstrapPayload?.error?.code === "UNAUTHORIZED",
  "bootstrap did not enforce v3 Bearer authentication",
);

console.log(
  "[m7-smoke] PASS Auth/REST/Storage/Kong, legacy 426, v3 claim start/poll, and bootstrap authentication",
);
