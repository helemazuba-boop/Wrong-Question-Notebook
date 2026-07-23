import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const sourceUrl = required("SOURCE_SUPABASE_URL");
const sourceKey = required("SOURCE_SUPABASE_SECRET_KEY");
const targetUrl = required("TARGET_SUPABASE_URL");
const targetKey = required("TARGET_SUPABASE_SECRET_KEY");
const sourceOrigin = new URL(sourceUrl).origin;
const targetOrigin = new URL(targetUrl).origin;
if (sourceOrigin !== sourceUrl.replace(/\/+$/, "")) {
  throw new Error("SOURCE_SUPABASE_URL must be an origin without a path");
}
if (
  targetOrigin !== "https://data.helema.cn" ||
  targetUrl.replace(/\/+$/, "") !== targetOrigin
) {
  throw new Error("TARGET_SUPABASE_URL must be https://data.helema.cn");
}
if (new URL(sourceUrl).protocol !== "https:") {
  throw new Error("SOURCE_SUPABASE_URL must use HTTPS");
}
if (!targetKey.startsWith("sb_secret_")) {
  throw new Error("TARGET_SUPABASE_SECRET_KEY must use the sb_secret_ format");
}
if (sourceOrigin === targetOrigin)
  throw new Error("Source and target must differ");

const source = createClient(sourceUrl, sourceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const target = createClient(targetUrl, targetKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const bucketNames = (process.env.STORAGE_BUCKETS || "avatars,problem-uploads")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const verifyBytes = process.env.VERIFY_STORAGE_BYTES !== "0";

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

async function ensureBucket(name) {
  const { data: sourceBucket, error: sourceError } =
    await source.storage.getBucket(name);
  if (sourceError || !sourceBucket) {
    throw new Error(
      `Unable to read source bucket ${name}: ${sourceError?.message}`,
    );
  }
  const { data: targetBucket, error: targetError } =
    await target.storage.getBucket(name);
  const targetStatus = String(
    targetError?.statusCode ?? targetError?.status ?? "",
  );
  if (targetError && targetStatus !== "404") {
    throw new Error(
      `Unable to inspect target bucket ${name}: ${targetError.message}`,
    );
  }
  if (targetBucket) {
    if (bucketPolicy(sourceBucket) !== bucketPolicy(targetBucket)) {
      throw new Error(`Bucket policy mismatch for ${name}`);
    }
    return;
  }
  const { error } = await target.storage.createBucket(name, {
    public: sourceBucket.public,
    fileSizeLimit: sourceBucket.file_size_limit ?? undefined,
    allowedMimeTypes: sourceBucket.allowed_mime_types ?? undefined,
  });
  if (error)
    throw new Error(`Unable to create target bucket ${name}: ${error.message}`);
}

async function listFiles(bucket, prefix = "") {
  const files = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await source.storage.from(bucket).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error)
      throw new Error(`Unable to list ${bucket}/${prefix}: ${error.message}`);
    for (const entry of data || []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) files.push(path);
      else files.push(...(await listFiles(bucket, path)));
    }
    if (!data || data.length < 100) return files;
    offset += data.length;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function copyObject(bucket, path) {
  const { data: sourceBlob, error: downloadError } = await source.storage
    .from(bucket)
    .download(path);
  if (downloadError || !sourceBlob) {
    throw new Error(
      `Unable to download ${bucket}/${path}: ${downloadError?.message}`,
    );
  }
  const bytes = Buffer.from(await sourceBlob.arrayBuffer());
  const { error: uploadError } = await target.storage
    .from(bucket)
    .upload(path, bytes, {
      contentType: sourceBlob.type || "application/octet-stream",
      upsert: true,
    });
  if (uploadError) {
    throw new Error(
      `Unable to upload ${bucket}/${path}: ${uploadError.message}`,
    );
  }
  const sourceDigest = digest(bytes);
  if (!verifyBytes) return { digest: sourceDigest, size: bytes.length };

  const { data: targetBlob, error: verifyError } = await target.storage
    .from(bucket)
    .download(path);
  if (verifyError || !targetBlob) {
    throw new Error(
      `Unable to verify ${bucket}/${path}: ${verifyError?.message}`,
    );
  }
  const targetBytes = Buffer.from(await targetBlob.arrayBuffer());
  if (sourceDigest !== digest(targetBytes)) {
    throw new Error(`Checksum mismatch for ${bucket}/${path}`);
  }
  return { digest: sourceDigest, size: bytes.length };
}

if (!verifyBytes) {
  console.warn(
    "[storage] WARNING: byte verification disabled; this run is not cutover evidence",
  );
}

for (const bucket of bucketNames) {
  await ensureBucket(bucket);
  const files = await listFiles(bucket);
  console.log(`[storage] ${bucket}: ${files.length} objects`);
  let copied = 0;
  let totalBytes = 0;
  const manifest = createHash("sha256");
  for (const path of files) {
    const result = await copyObject(bucket, path);
    totalBytes += result.size;
    manifest.update(path).update("\0");
    manifest.update(String(result.size)).update("\0");
    manifest.update(result.digest).update("\n");
    copied += 1;
    if (copied % 25 === 0 || copied === files.length) {
      console.log(`[storage] ${bucket}: copied ${copied}/${files.length}`);
    }
  }
  console.log(
    `[storage] ${bucket}: bytes=${totalBytes} manifest_sha256=${manifest.digest("hex")}`,
  );
}

console.log("[storage] migration and checksum verification complete");
