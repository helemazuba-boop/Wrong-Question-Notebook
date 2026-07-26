# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **ESP32 device-control v3**
  - Add versioned claim, bootstrap, and synchronization contracts with shared golden fixtures.
  - Pair physical devices through an expiring display code and P-256 ECDH/HKDF/AES-GCM sealed credentials.
  - Persist request idempotency so device retries return the original result after server restarts.
- **ESP32 credential hardening**
  - Store only SHA-256 device-token digests and provide authenticated token rotation.
  - Create the application storage buckets during database migration.
- **Data integrity foundations**
  - Add entity revisions and immutable provenance records for AI-created notebook notes.
  - Record authenticated administrative activity through an append-only audit path.

### Changed

- **ESP32 voice AI**
  - Add StepFun ASR selection for standard and professional voice sessions.
  - Accept both LF and CRLF event framing from upstream SSE providers.
  - Align v2 uploads on validated raw PCM headers and forward bounded thinking controls.
  - Translate provider reasoning chunks into device-visible thinking SSE events.

### Fixed

- **Word study sessions**
  - Bound per-user progress lookups to fixed 100-ID batches so large word decks cannot overflow the Node HTTP parser and stall ESP32 session creation.
- **Device synchronization**
  - Preserve SM-2 progress and user-timezone day boundaries for device reviews.
  - Use one device-authentication path so database failures cannot be mistaken for invalid credentials.
  - Remove temporary logging of Authorization header prefixes.
- **Provider errors**
  - Report upstream service failures consistently as `provider_unavailable` with HTTP 502.
- **Streaming request safety**
  - Apply authentication, rate limits, audio validation, and body-size limits to the v2 path.
