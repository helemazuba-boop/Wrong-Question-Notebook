import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnv(path) {
  const values = new Map();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid env line in ${path}`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function isPlaceholder(value) {
  const normalized = value.toLowerCase();
  return (
    !value ||
    normalized.includes("replace_") ||
    normalized.includes("replace-with") ||
    normalized.includes("your-") ||
    normalized.includes("your_") ||
    normalized.includes("xxxxxxxx")
  );
}

function required(env, key) {
  const value = env.get(key) || "";
  if (isPlaceholder(value)) throw new Error(`${key} is missing or placeholder`);
  return value;
}

function optional(env, key) {
  return env.get(key) || "";
}

const appPath = resolve(process.argv[2] || "web/.env.production");
const selfhostPath = resolve(
  process.argv[3] || "deploy/supabase-selfhost/.env",
);
const app = parseEnv(appPath);
const selfhost = parseEnv(selfhostPath);

const configuredPublicUrl = required(app, "NEXT_PUBLIC_SUPABASE_URL");
const publicUrl = new URL(configuredPublicUrl);
const publicOrigin = publicUrl.origin;
if (configuredPublicUrl.replace(/\/+$/, "") !== publicOrigin) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an origin without a path");
}
if (required(app, "WQN_SUPABASE_EXPECTED_HOST") !== publicUrl.hostname) {
  throw new Error("WQN_SUPABASE_EXPECTED_HOST must match the Supabase URL");
}
const allowedHttpOrigin = optional(app, "WQN_ALLOW_HTTP_SUPABASE_ORIGIN");
if (publicUrl.protocol === "http:" && allowedHttpOrigin !== publicOrigin) {
  throw new Error(
    "WQN_ALLOW_HTTP_SUPABASE_ORIGIN must exactly match the private HTTP Supabase origin",
  );
}
if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL must use HTTP or HTTPS");
}
if (publicUrl.protocol === "https:" && allowedHttpOrigin) {
  throw new Error("WQN_ALLOW_HTTP_SUPABASE_ORIGIN must be empty for HTTPS");
}
const siteOrigin = new URL(required(app, "SITE_URL")).origin;
const publishable = required(
  app,
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
);
const serverKey = required(app, "SUPABASE_SECRET_KEY");
if (!publishable.startsWith("sb_publishable_")) {
  throw new Error("App publishable key must use the sb_publishable_ format");
}
if (!serverKey.startsWith("sb_secret_")) {
  throw new Error("App server key must use the sb_secret_ format");
}
if (serverKey === publishable) throw new Error("Public and server keys match");
const serverActionsKey = required(app, "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(serverActionsKey)) {
  throw new Error("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY must be base64");
}
const serverActionsBytes = Buffer.from(serverActionsKey, "base64");
if (![16, 24, 32].includes(serverActionsBytes.length)) {
  throw new Error(
    "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY must decode to 16, 24, or 32 bytes",
  );
}
if (required(app, "WQN_REALTIME_PROXY_SECRET").length < 64) {
  throw new Error(
    "WQN_REALTIME_PROXY_SECRET must contain at least 64 characters",
  );
}
const internalUrl = new URL(required(app, "WQN_INTERNAL_API_BASE"));
if (internalUrl.protocol !== "http:" || internalUrl.hostname !== "wqn") {
  throw new Error(
    "WQN_INTERNAL_API_BASE must use the private Compose hostname",
  );
}
if (required(app, "WQN_INTERNAL_API_ALLOWED_HOST") !== "wqn:3000") {
  throw new Error("WQN_INTERNAL_API_ALLOWED_HOST must be wqn:3000");
}

if (
  new URL(required(selfhost, "SUPABASE_PUBLIC_URL")).origin !== publicOrigin
) {
  throw new Error("Application and self-hosted Supabase origins differ");
}
const apiExternalUrl = new URL(required(selfhost, "API_EXTERNAL_URL"));
if (
  apiExternalUrl.origin !== publicOrigin ||
  apiExternalUrl.pathname.replace(/\/+$/, "") !== "/auth/v1"
) {
  throw new Error("API_EXTERNAL_URL must use the Supabase /auth/v1 endpoint");
}
if (new URL(required(selfhost, "SITE_URL")).origin !== siteOrigin) {
  throw new Error("Application and self-hosted site origins differ");
}
if (
  !required(selfhost, "ADDITIONAL_REDIRECT_URLS")
    .split(",")
    .includes(`${siteOrigin}/auth/callback`)
) {
  throw new Error("Auth callback is absent from ADDITIONAL_REDIRECT_URLS");
}
for (const key of [
  "POSTGRES_PASSWORD",
  "JWT_SECRET",
  "ANON_KEY",
  "SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DASHBOARD_PASSWORD",
  "SECRET_KEY_BASE",
  "VAULT_ENC_KEY",
]) {
  required(selfhost, key);
}
if (
  !required(selfhost, "SUPABASE_PUBLISHABLE_KEY").startsWith("sb_publishable_")
) {
  throw new Error(
    "Self-hosted publishable key must use the sb_publishable_ format",
  );
}
if (!required(selfhost, "SUPABASE_SECRET_KEY").startsWith("sb_secret_")) {
  throw new Error("Self-hosted secret key must use the sb_secret_ format");
}
if (required(selfhost, "JWT_SECRET").length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters");
}
if (required(selfhost, "SECRET_KEY_BASE").length < 64) {
  throw new Error("SECRET_KEY_BASE must contain at least 64 characters");
}
if (Buffer.byteLength(required(selfhost, "VAULT_ENC_KEY")) !== 32) {
  throw new Error("VAULT_ENC_KEY must be exactly 32 bytes");
}
if (publishable !== required(selfhost, "SUPABASE_PUBLISHABLE_KEY")) {
  throw new Error("Application publishable key differs from self-hosted key");
}
if (serverKey !== required(selfhost, "SUPABASE_SECRET_KEY")) {
  throw new Error("Application server key differs from self-hosted key");
}

console.log("[config] application and self-hosted Supabase env validated");
