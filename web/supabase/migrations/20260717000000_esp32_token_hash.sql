-- ESP32 设备 access_token 哈希化存储 + 鉴权索引 + 配对留名
-- 修复 P1 凭证安全：明文 token -> SHA-256 哈希；现有 token 无损迁移。
-- 用哈希而非 bcrypt：配对 token 是 256bit 高熵随机串（randomBytes(32)），
-- 没有密码强度问题需要慢哈希来抵消。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- #1 哈希存储：新增 access_token_hash，回填现有明文，再删除明文列
ALTER TABLE public.esp32_devices ADD COLUMN IF NOT EXISTS access_token_hash text;

-- convert_to(...,'UTF8') -> bytea, so we hit pgcrypto's digest(bytea, text)
-- overload. The digest(text, text) overload is not exposed on this Supabase
-- instance. Node's createHash('sha256').update(token) defaults to UTF-8, so
-- the digests match byte-for-byte.
UPDATE public.esp32_devices
SET access_token_hash = encode(digest(convert_to(access_token, 'UTF8'), 'sha256'), 'hex')
WHERE access_token IS NOT NULL AND access_token_hash IS NULL;

ALTER TABLE public.esp32_devices DROP COLUMN IF EXISTS access_token;

-- #4 鉴权索引 + 唯一约束（兼解决 P3「access_token 无唯一约束」）
CREATE UNIQUE INDEX IF NOT EXISTS esp32_devices_token_hash_idx
  ON public.esp32_devices (access_token_hash);

-- #3 配对留名：pending 表加 device_name，让 poll 完成配对时保留设备名
ALTER TABLE public.esp32_pairing_pending ADD COLUMN IF NOT EXISTS device_name text;
