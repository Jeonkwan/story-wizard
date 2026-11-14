import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { SLUG_REGEX, validateSlug } from '../storage/storageAdapter.js';
import { createRequireAdminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/validators.js';
import { storyToCatalogItem } from '../services/geminiStory.js';
import type { CatalogItem, PodcastConfig } from '../../shared/types.js';

/**
 * Generates a URL-safe podcast slug matching `SLUG_REGEX` from a human-readable title.
 */
function slugifyPodcastTitle(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (base.length >= 2 && SLUG_REGEX.test(base)) {
    return base;
  }
  return `podcast-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Generates a 24-character hex token for private RSS feed URLs.
 */
function generatePrivateToken(): string {
  return crypto.randomBytes(12).toString('hex');
}

export function createAdminPodcastsRouter(config: AppConfig, storage: StorageAdapter): Router {
  const router = Router();
  const requireAdmin = createRequireAdminMiddleware(config);

  router.use(requireAdmin);

  // GET /api/admin/podcasts — Dynamic bucket/directory scan of all podcasts
  router.get(
    '/podcasts',
    asyncHandler(async (_req: Request, res: Response) => {
      const podcasts = await storage.listPodcasts();
      res.json({ podcasts });
    })
  );

  // POST /api/admin/podcasts — Create a new podcast feed config
  router.post(
    '/podcasts',
    asyncHandler(async (req: Request, res: Response) => {
      const { title, id, author, description, language, token } = req.body || {};

      if (typeof title !== 'string' || !title.trim()) {
        throw new ValidationError('Podcast title is required');
      }
      const cleanTitle = title.trim();

      const existing = await storage.listPodcasts();
      const existingIds = new Set(existing.map((p) => p.id));

      let podcastId: string;
      if (typeof id === 'string' && id.trim()) {
        podcastId = validateSlug(id.trim(), 'id');
        if (existingIds.has(podcastId)) {
          throw new ConflictError(`Podcast with id "${podcastId}" already exists`);
        }
      } else {
        const baseSlug = slugifyPodcastTitle(cleanTitle);
        podcastId = baseSlug;
        let suffix = 2;
        while (existingIds.has(podcastId)) {
          podcastId = `${baseSlug.slice(0, 72)}-${suffix}`;
          suffix++;
        }
        validateSlug(podcastId, 'id');
      }

      const now = new Date().toISOString();
      const cleanToken =
        typeof token === 'string' && token.trim() ? token.trim() : generatePrivateToken();

      const podcast: PodcastConfig = {
        id: podcastId,
        title: cleanTitle,
        author: typeof author === 'string' && author.trim() ? author.trim() : 'Storyteller Studio',
        description:
          typeof description === 'string' && description.trim()
            ? description.trim()
            : cleanTitle,
        language: typeof language === 'string' && language.trim() ? language.trim() : 'en-us',
        token: cleanToken,
        cover_image_url: null,
        episodes: [],
        created_at: now,
        updated_at: now,
      };

      await storage.savePodcast(podcast);
      res.status(201).json(podcast);
    })
  );

  // PATCH /api/admin/podcasts/:id — Update podcast metadata or rotate private token
  router.patch(
    '/podcasts/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const existing = await storage.getPodcast(id);
      const { title, author, description, language, token, regenerateToken } = req.body || {};

      if (title !== undefined) {
        if (typeof title !== 'string' || !title.trim()) {
          throw new ValidationError('Podcast title cannot be empty');
        }
        existing.title = title.trim();
      }
      if (author !== undefined) {
        existing.author =
          typeof author === 'string' && author.trim() ? author.trim() : 'Storyteller Studio';
      }
      if (description !== undefined) {
        existing.description = typeof description === 'string' ? description.trim() : '';
      }
      if (language !== undefined) {
        existing.language =
          typeof language === 'string' && language.trim() ? language.trim() : 'en-us';
      }

      if (regenerateToken === true) {
        existing.token = generatePrivateToken();
      } else if (token !== undefined && typeof token === 'string') {
        existing.token = token.trim();
      }

      existing.updated_at = new Date().toISOString();
      await storage.savePodcast(existing);
      res.json(existing);
    })
  );

  // DELETE /api/admin/podcasts/:id — Delete podcast config and folder
  router.delete(
    '/podcasts/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      await storage.getPodcast(id);
      await storage.deletePodcast(id);
      res.json({ ok: true, deletedId: id });
    })
  );

  // POST /api/admin/podcasts/:id/episodes — Release or update a story episode (strictly deduplicated by story_id)
  router.post(
    '/podcasts/:id/episodes',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      validateSlug(id, 'id');

      const { storyId, versionId } = req.body || {};
      if (typeof storyId !== 'string' || !storyId.trim()) {
        throw new ValidationError('storyId is required');
      }
      const cleanStoryId = validateSlug(storyId.trim(), 'storyId');

      const podcast = await storage.getPodcast(id);
      const story = await storage.getStory(cleanStoryId);

      if (!story.audio_versions || story.audio_versions.length === 0) {
        throw new ValidationError('Cannot release a story without synthesized audio to a podcast');
      }

      const targetVer = versionId
        ? story.audio_versions.find((v) => v.version_id === versionId)
        : story.audio_versions.find((v) => v.is_default) || story.audio_versions[0];

      if (!targetVer) {
        throw new NotFoundError(`Audio version not found on story "${cleanStoryId}": "${versionId}"`);
      }

      // Auto-promote draft story with audio to published so RSS enclosures are publicly streamable
      if (story.status !== 'published') {
        story.status = 'published';
        story.updated_at = new Date().toISOString();
        await storage.saveStory(story);

        const catalogItem = storyToCatalogItem(story);
        await storage.updateJsonAtomic<CatalogItem[]>(
          'catalog.json',
          (current) => {
            const list = current ? [...current] : [];
            const idx = list.findIndex((c) => c.id === story.id);
            if (idx >= 0) {
              list[idx] = catalogItem;
            } else {
              list.unshift(catalogItem);
            }
            return list;
          },
          []
        );
      }

      const now = new Date().toISOString();
      const updatedPodcast = await storage.updateJsonAtomic<PodcastConfig>(
        `podcasts/${id}/podcast.json`,
        (current) => {
          const base = current || podcast;
          const episodes = Array.isArray(base.episodes) ? [...base.episodes] : [];
          const existingIdx = episodes.findIndex((ep) => ep.story_id === cleanStoryId);
          if (existingIdx >= 0) {
            episodes[existingIdx] = {
              story_id: cleanStoryId,
              version_id: targetVer.version_id,
              published_at: now,
            };
          } else {
            episodes.unshift({
              story_id: cleanStoryId,
              version_id: targetVer.version_id,
              published_at: now,
            });
          }
          return {
            ...base,
            episodes,
            updated_at: now,
          };
        }
      );

      // Re-attach detected cover_image_url if present on storage
      if (!updatedPodcast.cover_image_url && podcast.cover_image_url) {
        updatedPodcast.cover_image_url = podcast.cover_image_url;
      }

      res.json(updatedPodcast);
    })
  );

  // DELETE /api/admin/podcasts/:id/episodes/:storyId — Unrelease an episode from a podcast
  router.delete(
    '/podcasts/:id/episodes/:storyId',
    asyncHandler(async (req: Request, res: Response) => {
      const { id, storyId } = req.params;
      validateSlug(id, 'id');
      validateSlug(storyId, 'storyId');

      const podcast = await storage.getPodcast(id);
      const now = new Date().toISOString();

      const updatedPodcast = await storage.updateJsonAtomic<PodcastConfig>(
        `podcasts/${id}/podcast.json`,
        (current) => {
          const base = current || podcast;
          const episodes = (base.episodes || []).filter((ep) => ep.story_id !== storyId);
          return {
            ...base,
            episodes,
            updated_at: now,
          };
        }
      );

      if (!updatedPodcast.cover_image_url && podcast.cover_image_url) {
        updatedPodcast.cover_image_url = podcast.cover_image_url;
      }

      res.json(updatedPodcast);
    })
  );

  return router;
}
