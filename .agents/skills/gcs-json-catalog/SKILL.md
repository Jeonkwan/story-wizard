---
name: gcs-json-catalog
description: Authoritative guide for dual-mode GCS and local filesystem JSON catalog persistence, optimistic locking via ifGenerationMatch, and HTTP Range partial audio streaming.
---

# GCS & Local JSON Catalog Skill

## Architecture & Storage Principles
- **No Database:** No Postgres, MySQL, SQLite, Firestore, Redis, or Prisma.
- Persistence is stored in JSON and WAV objects:
  - Local mode: `./data/catalog.json`, `./data/voices.json`, `./data/stories/{id}/story.json`, `./data/stories/{id}/audios/{ver}.wav`.
  - Cloud mode: `gs://${GCS_BUCKET_NAME}/...`.
- If `GCS_BUCKET_NAME` is empty or unset, fall back automatically to `LocalStorageAdapter`.

## Optimistic Concurrency Control
- In GCS, use `ifGenerationMatch` preconditions to prevent race conditions when updating `catalog.json` or `voices.json`.
- Retry up to 3 times on HTTP 412 Precondition Failed.
- In local storage, write atomically using temporary files (`.tmp-${pid}-${Date.now()}`) and `fs.promises.rename()`.

## Path Traversal Protection
- All `storyId` and `versionId` params must be validated against `/^[a-z0-9][a-z0-9-_]{1,80}$/` to prevent directory traversal attacks.

## HTTP Range Audio Streaming
- WAV audio streaming endpoints (`GET /api/stories/:id/audios/:filename`) must support the `Range: bytes=start-end` header.
- Respond with:
  - `206 Partial Content` when `Range` is provided and valid, with `Content-Range: bytes start-end/total` and `Content-Length: (end - start + 1)`.
  - `200 OK` with full content when no `Range` header is present, including `Accept-Ranges: bytes` and `Content-Length: total`.
  - `416 Range Not Satisfiable` with `Content-Range: bytes */total` when out of bounds.
