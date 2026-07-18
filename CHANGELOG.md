# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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

### Fixed

- **Device synchronization**
  - Preserve SM-2 progress and user-timezone day boundaries for device reviews.
  - Use one device-authentication path so database failures cannot be mistaken for invalid credentials.
  - Remove temporary logging of Authorization header prefixes.
- **Provider errors**
  - Report upstream service failures consistently as `provider_unavailable` with HTTP 502.
