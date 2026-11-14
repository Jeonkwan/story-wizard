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
 * Escapes special XML characters so RSS 2.0 channel and item fields stay well-formed.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Shared HTTP Range partial audio streaming helper.
 * Supports standard 200 OK for full audio, 206 Partial Content for valid byte ranges,
 * and 416 Range Not Satisfiable for out-of-bounds or malformed range requests.
 */
export function streamAudioWithRange(
  req: Request,
  res: Response,
  audioDesc: AudioStreamDescriptor,
  cacheControl: string,
  contentType = 'audio/wav'
): void {
  const totalBytes = audioDesc.totalBytes;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
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

      // Validate audio filename: must be <validSlug>.m4a or <validSlug>.wav
      if (!filename.endsWith('.m4a') && !filename.endsWith('.wav')) {
        res.status(400).json({ error: 'Audio filename must end with .m4a or .wav' });
        return;
      }
      const ext = filename.endsWith('.m4a') ? 'm4a' : 'wav';
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

      // Retrieve audio stream descriptor (.m4a default stream or lossless .wav)
      let audioDesc;
      try {
        audioDesc =
          ext === 'm4a'
            ? await storage.getAudioM4aStream(id, versionId)
            : await storage.getAudioStream(id, versionId);
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: 'Audio not found' });
          return;
        }
        throw err;
      }

      if (ext === 'wav' && (req.query.download === '1' || req.query.download === 'true')) {
        res.setHeader('Content-Disposition', `attachment; filename="${id}-${versionId}.wav"`);
      }

      const cacheControl =
        story.status === 'published'
          ? 'public, max-age=31536000, immutable'
          : 'private, no-store';

      const contentType = ext === 'm4a' ? 'audio/mp4' : 'audio/wav';
      streamAudioWithRange(req, res, audioDesc, cacheControl, contentType);
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

  // GET /api/podcasts/:podcastId/feed.xml
  router.get(
    '/podcasts/:podcastId/feed.xml',
    asyncHandler(async (req: Request, res: Response) => {
      const { podcastId } = req.params;
      try {
        validateSlug(podcastId, 'podcastId');
      } catch {
        res.status(400).json({ error: `Invalid podcast id: "${podcastId}"` });
        return;
      }

      let podcast;
      try {
        podcast = await storage.getPodcast(podcastId);
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: `Podcast not found: "${podcastId}"` });
          return;
        }
        throw err;
      }

      // Private token guard
      if (podcast.token && podcast.token.trim().length > 0) {
        if (req.query.token !== podcast.token) {
          res.status(403).json({ error: 'Invalid or missing podcast feed token' });
          return;
        }
      }

      // Reverse-proxy base URL resolution
      const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)
        ?.split(',')[0]
        ?.trim();
      const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)
        ?.split(',')[0]
        ?.trim();
      const proto = forwardedProto || req.protocol || 'https';
      const host = forwardedHost || req.get('host') || 'localhost:8080';
      const baseUrl = (process.env.PUBLIC_BASE_URL || `${proto}://${host}`).replace(/\/+$/, '');

      const itemsXml: string[] = [];
      for (const ep of podcast.episodes || []) {
        let story;
        try {
          story = await storage.getStory(ep.story_id);
        } catch {
          continue; // Skip deleted/missing stories cleanly
        }
        if (story.status !== 'published' || !story.audio_versions?.length) {
          continue; // Skip drafts or stories without audio
        }

        const ver =
          story.audio_versions.find((v) => v.version_id === ep.version_id) ||
          story.audio_versions.find((v) => v.is_default) ||
          story.audio_versions[0];
        if (!ver) continue;

        const m4aSizeBytes =
          ver.m4a_size_bytes ||
          (await storage
            .getAudioM4aStream(story.id, ver.version_id)
            .then((d) => d.totalBytes)
            .catch(() => 0));

        const enclosureUrl = `${baseUrl}/api/stories/${story.id}/audios/${ver.version_id}.m4a`;
        const storyLink = `${baseUrl}/stories/${story.id}`;
        const pubDate = new Date(ep.published_at || story.updated_at).toUTCString();
        const durationSec = Math.max(0, Math.round(ver.duration_sec));
        const guid = `${podcast.id}:${story.id}:${ver.version_id}`;
        const episodeTag =
          story.series_context?.episode_number != null
            ? `\n      <itunes:episode>${story.series_context.episode_number}</itunes:episode>`
            : '';

        itemsXml.push(`    <item>
      <title>${escapeXml(story.title)}</title>
      <link>${escapeXml(storyLink)}</link>
      <description>${escapeXml(story.summary || story.title)}</description>
      <itunes:summary>${escapeXml(story.summary || story.title)}</itunes:summary>
      <pubDate>${escapeXml(pubDate)}</pubDate>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <itunes:duration>${durationSec}</itunes:duration>${episodeTag}
      <enclosure url="${escapeXml(enclosureUrl)}" length="${m4aSizeBytes}" type="audio/x-m4a" />
    </item>`);
      }

      const coverUrl = podcast.cover_image_url
        ? podcast.cover_image_url.startsWith('http://') ||
          podcast.cover_image_url.startsWith('https://')
          ? podcast.cover_image_url
          : `${baseUrl}${podcast.cover_image_url.startsWith('/') ? '' : '/'}${podcast.cover_image_url}`
        : null;

      const coverXml = coverUrl
        ? `\n    <itunes:image href="${escapeXml(coverUrl)}" />\n    <image>\n      <url>${escapeXml(coverUrl)}</url>\n      <title>${escapeXml(podcast.title)}</title>\n      <link>${escapeXml(baseUrl)}</link>\n    </image>`
        : '';

      const feedUrl = `${baseUrl}/api/podcasts/${podcast.id}/feed.xml${
        podcast.token ? `?token=${encodeURIComponent(podcast.token)}` : ''
      }`;

      const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(podcast.title)}</title>
    <link>${escapeXml(baseUrl)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(podcast.description || podcast.title)}</description>
    <language>${escapeXml(podcast.language || 'en-us')}</language>
    <itunes:author>${escapeXml(podcast.author || 'Storyteller Studio')}</itunes:author>
    <itunes:summary>${escapeXml(podcast.description || podcast.title)}</itunes:summary>
    <itunes:explicit>false</itunes:explicit>${coverXml}
${itemsXml.join('\n')}
  </channel>
</rss>`;

      res.status(200);
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(rssXml);
    })
  );

  // GET /api/podcasts/:podcastId/cover.:ext (jpg | png)
  router.get(
    '/podcasts/:podcastId/cover.:ext',
    asyncHandler(async (req: Request, res: Response) => {
      const { podcastId, ext } = req.params;
      if (ext !== 'jpg' && ext !== 'png') {
        res.status(400).json({ error: 'Cover extension must be .jpg or .png' });
        return;
      }

      try {
        validateSlug(podcastId, 'podcastId');
      } catch {
        res.status(400).json({ error: `Invalid podcast id: "${podcastId}"` });
        return;
      }

      try {
        const { streamDesc, contentType } = await storage.getPodcastCoverStream(podcastId);
        streamAudioWithRange(req, res, streamDesc, 'public, max-age=3600', contentType);
      } catch (err: unknown) {
        if (err instanceof StorageNotFoundError) {
          res.status(404).json({ error: `Podcast cover not found: "${podcastId}"` });
          return;
        }
        throw err;
      }
    })
  );

  return router;
}
