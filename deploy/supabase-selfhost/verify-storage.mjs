#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromWorkingDirectory = createRequire(resolve("package.json"));
const { createClient } = requireFromWorkingDirectory("@supabase/supabase-js");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactOrigin(name) {
  const value = required(name);
  const parsed = new URL(value);
  if (parsed.origin !== value.replace(/\/+$/, "")) {
    throw new Error(`${name} must be an origin without a path`);
  }
  return parsed.origin;
}

const sourceOrigin = exactOrigin("SOURCE_SUPABASE_URL");
const targetOrigin = exactOrigin("TARGET_SUPABASE_URL");
if (new URL(sourceOrigin).protocol !== "https:") {
  throw new Error("SOURCE_SUPABASE_URL must use HTTPS");
}
if (!new Set(["http:", "https:"]).has(new URL(targetOrigin).protocol)) {
  throw new Error("TARGET_SUPABASE_URL must use HTTP or HTTPS");
}
if (sourceOrigin === targetOrigin) throw new Error("Source and target must differ");
if (required("CONFIRM_TARGET_SUPABASE_ORIGIN") !== targetOrigin) {
  throw new Error("CONFIRM_TARGET_SUPABASE_ORIGIN must exactly match TARGET_SUPABASE_URL");
}

const source = createClient(sourceOrigin, required("SOURCE_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const target = createClient(targetOrigin, required("TARGET_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const buckets = (process.env.STORAGE_BUCKETS || "avatars,problem-uploads,word-packs")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const verifyBytes = process.env.VERIFY_STORAGE_BYTES !== "0";
const reportPaths = process.env.REPORT_OBJECT_PATHS === "1";

function normalizedMimeTypes(values) {
  return [...(values || [])].sort();
}

function bucketPolicy(bucket) {
  return JSON.stringify({
    public: Boolean(bucket.public),
    fileSizeLimit: bucket.file_size_limit ?? null,
    allowedMimeTypes: normalizedMimeTypes(bucket.allowed_mime_types),
  });
}

async function getBucket(client, side, name) {
  const { data, error } = await client.storage.getBucket(name);
  if (error || !data) throw new Error(`${side} bucket ${name}: ${error?.message}`);
  return data;
}

async function listFiles(client, side, bucket, prefix = "") {
  const files = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`${side} list ${bucket}/${prefix}: ${error.message}`);
    for (const entry of data || []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) files.push(path);
      else files.push(...(await listFiles(client, side, bucket, path)));
    }
    if (!data || data.length < 100) return files;
    offset += data.length;
  }
}

async function objectBytes(client, side, bucket, path) {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`${side} download ${bucket}/${path}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (!verifyBytes) {
  console.warn("[storage-verify] byte verification disabled; this is not cutover evidence");
}

for (const bucket of buckets) {
  const [sourceBucket, targetBucket] = await Promise.all([
    getBucket(source, "source", bucket),
    getBucket(target, "target", bucket),
  ]);
  if (bucketPolicy(sourceBucket) !== bucketPolicy(targetBucket)) {
    throw new Error(`bucket policy mismatch: ${bucket}`);
  }

  const [sourcePaths, targetPaths] = await Promise.all([
    listFiles(source, "source", bucket),
    listFiles(target, "target", bucket),
  ]);
  sourcePaths.sort();
  targetPaths.sort();
  const sourceSet = new Set(sourcePaths);
  const targetSet = new Set(targetPaths);
  const missing = sourcePaths.filter((path) => !targetSet.has(path));
  const extra = targetPaths.filter((path) => !sourceSet.has(path));
  console.log(
    `[storage-verify] ${bucket}: source=${sourcePaths.length} target=${targetPaths.length} missing=${missing.length} extra=${extra.length}`,
  );
  if (reportPaths) {
    for (const path of missing) console.log(`[storage-verify] missing ${bucket}/${path}`);
    for (const path of extra) console.log(`[storage-verify] extra ${bucket}/${path}`);
  }
  if (missing.length || extra.length) {
    throw new Error(`object path set mismatch: ${bucket}`);
  }
  if (!verifyBytes) continue;

  const sourceManifest = createHash("sha256");
  const targetManifest = createHash("sha256");
  let totalBytes = 0;
  for (const path of sourcePaths) {
    const [sourceBytes, targetBytes] = await Promise.all([
      objectBytes(source, "source", bucket, path),
      objectBytes(target, "target", bucket, path),
    ]);
    const sourceDigest = digest(sourceBytes);
    const targetDigest = digest(targetBytes);
    if (sourceBytes.length !== targetBytes.length || sourceDigest !== targetDigest) {
      throw new Error(`object byte mismatch: ${bucket}/${path}`);
    }
    totalBytes += sourceBytes.length;
    for (const [manifest, bytes, objectDigest] of [
      [sourceManifest, sourceBytes, sourceDigest],
      [targetManifest, targetBytes, targetDigest],
    ]) {
      manifest.update(path).update("\0");
      manifest.update(String(bytes.length)).update("\0");
      manifest.update(objectDigest).update("\n");
    }
  }
  const sourceManifestDigest = sourceManifest.digest("hex");
  const targetManifestDigest = targetManifest.digest("hex");
  if (sourceManifestDigest !== targetManifestDigest) {
    throw new Error(`manifest mismatch: ${bucket}`);
  }
  console.log(
    `[storage-verify] ${bucket}: bytes=${totalBytes} manifest_sha256=${sourceManifestDigest}`,
  );
}

console.log("[storage-verify] source and target Storage are identical");
