/**
 * types.ts — shared types & constants.
 *
 * All magic numbers here are mirrored from the ESP32 firmware
 * (firmware/wqn-zectrix-note4/main/config.h and main/flash_session.cpp).
 * Keep these in sync when bumping firmware-side constants.
 */

export const WFLV_AUDIO_MAGIC = 0x57464c56; // 'W','F','L','V' — uplink/downlink audio
export const WFCJ_CONTROL_MAGIC = 0x5746434a; // 'W','F','C','J' — reserved for future
export const WFLV_FRAME_VERSION = 2;
export const WFLV_HEADER_BYTES = 24;

export const WFLV_FLAG_STREAM = 0x0001;
export const WFLV_FLAG_FINAL = 0x0002;

export const UPLINK_SAMPLE_RATE_HZ = 24000;
export const UPLINK_CHANNELS = 1;
export const CHUNK_FRAMES = 360; // 15 ms @ 24 kHz — locked by StepFun VAD window
export const CHUNK_BYTES = CHUNK_FRAMES * 2; // int16

export const DOWLINK_DEFAULT_SAMPLE_RATE_HZ = 24000; // PCM16 @ 24 kHz (matches firmware I2S duplex)
export const PROXY_SUBPROTOCOL = 'wqn-flash-v2';
export const VOICE_SUBPROTOCOL = 'wqn-voice-v2';
export const STD_PRO_SAMPLE_RATE_HZ = 16000;
export const MAX_STD_PRO_PCM_BYTES = 16000 * 2 * 20 + 4096; // 20s 16k s16le + tolerance
export const ALLOWED_VOICES_CSV =
  process.env.WQN_FLASH_ALLOWED_VOICES ?? 'qingchunshaonv,cixingnansheng';
export const ALLOWED_VOICES = new Set(
  ALLOWED_VOICES_CSV.split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

export interface DeviceContext {
  userId: string;
  deviceId: string;
  macAddress: string;
}

export interface UplinkAudioHeader {
  readonly magic: number;
  readonly version: number;
  readonly flags: number;
  readonly seq: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export type RelayErrorCode =
  | 'unauthorized'
  | 'disabled'
  | 'rate_limited'
  | 'protocol_mismatch'
  | 'voice_not_allowed'
  | 'upstream_unavailable'
  | 'tts_failed'
  | 'tts_timeout'
  | 'ws_proxy_error'
  | 'internal';

export interface RelayErrorPayload {
  error_code: RelayErrorCode;
  stage?: string;
  message?: string;
  latency_ms?: number;
}

export function makeError(
  code: RelayErrorCode,
  message: string,
  stage?: string
): RelayErrorPayload {
  const e: RelayErrorPayload = { error_code: code, message };
  if (stage) e.stage = stage;
  return e;
}
