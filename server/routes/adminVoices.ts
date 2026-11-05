import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { createRequireAdminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { GeminiTtsService } from '../services/geminiTts.js';

export function createAdminVoicesRouter(
  config: AppConfig,
  storage: StorageAdapter,
  ttsService: GeminiTtsService
): Router {
  const router = Router();
  const requireAdmin = createRequireAdminMiddleware(config);

  // All voice management routes require admin authentication
  router.use(requireAdmin);

  // GET /api/admin/voices — list all saved voices
  router.get(
    '/voices',
    asyncHandler(async (_req: Request, res: Response) => {
      const voices = await storage.getVoices();
      res.json(voices);
    })
  );

  // POST /api/admin/voices/preview — 5s audio audition preview
  router.post(
    '/voices/preview',
    asyncHandler(async (req: Request, res: Response) => {
      const { voiceId, description, sampleText } = req.body || {};

      const wavBuffer = await ttsService.previewVoice({
        voiceId: typeof voiceId === 'string' ? voiceId.trim() : undefined,
        description: typeof description === 'string' ? description.trim() : undefined,
        sampleText: typeof sampleText === 'string' ? sampleText.trim() : undefined,
      });

      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', wavBuffer.length);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(wavBuffer);
    })
  );

  // POST /api/admin/voices — design custom voice via Voices API + append to voices.json
  router.post(
    '/voices',
    asyncHandler(async (req: Request, res: Response) => {
      const { label, description, languageCode, tags } = req.body || {};

      if (!label || typeof label !== 'string' || !label.trim()) {
        res.status(400).json({ error: 'Voice label is required' });
        return;
      }
      if (!description || typeof description !== 'string' || !description.trim()) {
        res.status(400).json({ error: 'Voice description is required' });
        return;
      }

      const created = await ttsService.createAndSaveVoice({
        label: label.trim(),
        description: description.trim(),
        languageCode: typeof languageCode === 'string' ? languageCode.trim() : undefined,
        tags: Array.isArray(tags) ? tags : undefined,
      });

      res.status(201).json(created);
    })
  );

  return router;
}
