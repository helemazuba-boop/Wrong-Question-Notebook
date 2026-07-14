-- ============================================================================
-- ESP32 v2 设备字段扩展
-- ============================================================================
-- Adds the fields needed by:
--   * WQN Cloud Relay Part A (HTTP+SSE std/pro) — preferred_tier + last protocol
--   * WQN Cloud Relay Part B (Flash Realtime v2)  — flash_session_id + expires_at
--
-- Reference: wqn-cloud-relay/docs/12-cloud-side-tasks.md §12.2 (P1 item ⑦)
-- Backwards compatible: every new column has a DEFAULT so legacy devices keep
-- working until the firmware upgrades and starts writing the values.

ALTER TABLE public.esp32_devices
  -- Flash Realtime v2: opaque session id the WQN Realtime proxy hands back to
  -- the device in session.created. 30-day TTL is enforced server-side via
  -- flash_session_expires_at; the device stores this in NVS to resume.
  ADD COLUMN IF NOT EXISTS flash_session_id text,
  ADD COLUMN IF NOT EXISTS flash_session_expires_at timestamptz,

  -- Records the protocol version that completed the last successful call so
  -- the server can decide which rate-limit bucket and code path to use
  -- without trusting the X-WQN-Protocol header on every request.
  ADD COLUMN IF NOT EXISTS last_protocol_version text NOT NULL DEFAULT 'v1',

  -- Which AI tier the device prefers. The firmware can still override per-call
  -- via X-WQN-Ai-Tier, this just lets the web UI surface "always uses std".
  ADD COLUMN IF NOT EXISTS preferred_tier text NOT NULL DEFAULT 'std'
    CHECK (preferred_tier IN ('flash', 'std', 'pro'));

-- ============================================================================
-- Indexes for the new lookup patterns
-- ============================================================================

-- Flash proxy hot path: lookup device by session id when the device reconnects
-- with a saved flash_session_id. NULLs are excluded from the index so legacy
-- devices that never used Flash don't bloat it.
CREATE INDEX IF NOT EXISTS esp32_devices_flash_session_idx
  ON public.esp32_devices (flash_session_id)
  WHERE flash_session_id IS NOT NULL;

-- Web dashboard listing devices by preferred tier per user.
CREATE INDEX IF NOT EXISTS esp32_devices_user_tier_idx
  ON public.esp32_devices (user_id, preferred_tier);

-- ============================================================================
-- RLS — already permissive, but explicitly grant the service role the new
-- columns for the Realtime proxy hot path (it uses the service client).
-- No policy change needed: "Users can manage own devices" covers all columns.
-- ============================================================================

COMMENT ON COLUMN public.esp32_devices.flash_session_id IS
  'Opaque WQN Flash Realtime v2 session id; rotated every 30 days.';

COMMENT ON COLUMN public.esp32_devices.flash_session_expires_at IS
  'When the flash_session_id above is no longer accepted by the proxy.';

COMMENT ON COLUMN public.esp32_devices.last_protocol_version IS
  'Last successful protocol version (v1 | v2-streaming | flash-v2).';

COMMENT ON COLUMN public.esp32_devices.preferred_tier IS
  'Default AI tier when the firmware does not override per-call.';