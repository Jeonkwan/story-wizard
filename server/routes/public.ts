import { Router } from 'express';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream';
import type { AppConfig } from '../config.js';
import {
  type StorageAdapter,
  type AudioStreamDescriptor,
  StorageNotFoundError,
  validateSlug,
} from '../storage/storageAdapter.js';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

/**
 * Shared HTTP Range partial audio streaming helper.
 * Supports standard 200 OK for full audio, 206 Partial Content for valid byte ranges,
 * and 416 Range Not Satisfiable for out-of-bounds or malformed range requests.
 */
export function streamAudioWithRange(
  req: Request,
  res: Response,
  audioDesc: AudioStreamDescriptor,
  cacheControl: string
): void {
  const totalBytes = audioDesc.totalBytes;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', cacheControl);

  const rangeHeader = req.headers.range;

  // No Range requested: return standard 200 OK
  if (!rangeHeader) {
    res.status(200);
    res.setHeader('Content-Length', totalBytes);
    pipeline(audioDesc.createStream(), res, () => {});
    return;
  }

  // Range requested: validate and parse
  if (!rangeHeader.startsWith('bytes=') || totalBytes === 0) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalBytes}`);
    res.end();
    return;
  }

  const rangeSpec = rangeHeader.slice('bytes='.length).trim();
  let start: number;
  let end: number;

  const parts = rangeSpec.split('-');
  if (parts.length !== 2) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalBytes}`);
    res.end();
    return;
  }

  const [startStr, endStr] = parts;

  if (startStr === '' && endStr !== '') {
    // Suffix range: bytes=-500
    if (!/^\d+$/.test(endStr)) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalBytes}`);
      res.end();
      return;
    }
    const suffixLen = parseInt(endStr, 10);
    if (suffixLen <= 0) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalBytes}`);
      res.end();
      return;
    }
    start = Math.max(0, totalBytes - suffixLen);
    end = totalBytes - 1;
  } else if (startStr !== '' && endStr === '') {
    // Open-ended range: bytes=500-
    if (!/^\d+$/.test(startStr)) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalBytes}`);
      res.end();
      return;
    }
    start = parseInt(startStr, 10);
    end = totalBytes - 1;
  } else if (startStr !== '' && endStr !== '') {
    // Explicit range: bytes=0-43
    if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalBytes}`);
      res.end();
      return;
    }
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (start < 0 || end < start) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalBytes}`);
      res.end();
      return;
    }
  } else {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalBytes}`);
    res.end();
    return;
  }

  // Bounds check
  if (start >= totalBytes) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${totalBytes}`);
    res.end();
    return;
  }

  end = Math.min(end, totalBytes - 1);
  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${totalBytes}`);
  res.setHeader('Content-Length', chunkSize);
  pipeline(audioDesc.createStream({ start, end }), res, () => {});
}

export function createPublicRouter(config: AppConfig, storage: StorageAdapter): Router {
  const router = Router();

  // Helper to check admin status from cookie
  function isAdmin(req: Request): boolean {
    const cookieToken = req.cookies?.[ADMIN_COOKIE_NAME];
    const session = verifyAdminSession(cookieToken, config.sessionSecret, config);
    return Boolean(session);
  }

  // GET /api/catalog
  router.get(
    '/catalog',
    asyncHandler(async (req: Request, res: Response) => {
      const includeDrafts = req.query.includeDrafts === 'true' && isAdmin(req);
      const catalog = await storage.getCatalog();

      // Filter to published only unless admin explicitly requested includeDrafts
      const filtered = includeDrafts
        ? catalog
        : catalog.filter((item) => item.status === 'published');

      // Sort newest-first (created_at desc)
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      res.json(filtered);
    })
  );

  // GET /api/stories/:id
  router.get(
    '/stories/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      try {
        validateSlug(id, 'id');
      } catch {
        res.status(400).json({ error: `Invalid story id: "${id}"` });
        return;
      }

      try {
        const story = await storage.getStory(id);
        if (story.status === 'draft' && !isAdmin(req)) {
          res.status(404).json({ error: `Story not found: "${id}"` });
          return;
        }
        res.json(story);
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: `Story not found: "${id}"` });
          return;
        }
        throw err;
      }
    })
  );

  // GET /api/stories/:id/audios/:filename
  router.get(
    '/stories/:id/audios/:filename',
    asyncHandler(async (req: Request, res: Response) => {
      const { id, filename } = req.params;

      // Validate story id slug
      try {
        validateSlug(id, 'id');
      } catch {
        res.status(400).json({ error: `Invalid story id: "${id}"` });
        return;
      }

      // Validate audio filename: must be <validSlug>.wav
      if (!filename.endsWith('.wav')) {
        res.status(400).json({ error: 'Audio filename must end with .wav' });
        return;
      }
      const versionId = filename.slice(0, -4);
      try {
        validateSlug(versionId, 'versionId');
      } catch {
        res.status(400).json({ error: `Invalid audio version slug: "${versionId}"` });
        return;
      }

      // Verify story status and draft privacy
      let story;
      try {
        story = await storage.getStory(id);
        if (story.status === 'draft' && !isAdmin(req)) {
          res.status(404).json({ error: 'Audio not found' });
          return;
        }
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: 'Audio not found' });
          return;
        }
        throw err;
      }

      // Retrieve audio stream descriptor
      let audioDesc;
      try {
        audioDesc = await storage.getAudioStream(id, versionId);
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: 'Audio not found' });
          return;
        }
        throw err;
      }

      const cacheControl =
        story.status === 'published'
          ? 'public, max-age=31536000, immutable'
          : 'private, no-store';

      streamAudioWithRange(req, res, audioDesc, cacheControl);
    })
  );

  // GET /api/voices/:id/preview.wav
  router.get(
    '/voices/:id/preview.wav',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;

      try {
        validateSlug(id, 'id');
      } catch {
        res.status(400).json({ error: `Invalid voice id: "${id}"` });
        return;
      }

      try {
        const audioDesc = await storage.getVoicePreviewStream(id);
        streamAudioWithRange(req, res, audioDesc, 'public, max-age=3600');
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: `Voice preview not found: "${id}"` });
          return;
        }
        throw err;
      }
    })
  );

  return router;
}
