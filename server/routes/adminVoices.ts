import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { validateSlug } from '../storage/storageAdapter.js';
import { createRequireAdminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { GeminiTtsService } from '../services/geminiTts.js';
import { ValidationError, ConflictError, NotFoundError } from '../lib/validators.js';
import type { VoicePace } from '../../shared/types.js';

const VALID_PACES: VoicePace[] = ['slow', 'calm', 'natural', 'lively'];

export function createAdminVoicesRouter(
  config: AppConfig,
  _storage: StorageAdapter,
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
      const voices = await ttsService.listVoices();
      res.json(voices);
    })
  );

  // POST /api/admin/voices/preview — audio audition preview (staged draft or saved voice)
  router.post(
    '/voices/preview',
    asyncHandler(async (req: Request, res: Response) => {
      const {
        voiceId,
        description,
        sampleText,
        pace,
        draftGeminiVoiceName,
        previousDraftGeminiVoiceName,
        regenerateTake,
      } = req.body || {};

      if (pace !== undefined && !VALID_PACES.includes(pace)) {
        res.status(400).json({
          error: `Invalid voice pace: "${pace}". Must be one of: slow, calm, natural, lively`,
        });
        return;
      }

      try {
        const result = await ttsService.previewVoice({
          voiceId: typeof voiceId === 'string' ? voiceId.trim() : undefined,
          description: typeof description === 'string' ? description.trim() : undefined,
          sampleText: typeof sampleText === 'string' ? sampleText.trim() : undefined,
          pace,
          draftGeminiVoiceName:
            typeof draftGeminiVoiceName === 'string' ? draftGeminiVoiceName.trim() : undefined,
          previousDraftGeminiVoiceName:
            typeof previousDraftGeminiVoiceName === 'string'
              ? previousDraftGeminiVoiceName.trim()
              : undefined,
          regenerateTake: Boolean(regenerateTake),
        });

        if (result.draftGeminiVoiceName) {
          res.setHeader('X-Draft-Voice-Name', result.draftGeminiVoiceName);
          res.setHeader('Access-Control-Expose-Headers', 'X-Draft-Voice-Name');
        }

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', result.wav.length);
        res.setHeader('Cache-Control', 'private, no-store');
        res.send(result.wav);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // POST /api/admin/voices — design custom voice or promote staged draft + append to voices.json
  router.post(
    '/voices',
    asyncHandler(async (req: Request, res: Response) => {
      const {
        label,
        description,
        languageCode,
        tags,
        defaultPace,
        stagedGeminiVoiceName,
        previewAudioBase64,
      } = req.body || {};

      if (!label || typeof label !== 'string' || !label.trim()) {
        res.status(400).json({ error: 'Voice label is required' });
        return;
      }
      if (!description || typeof description !== 'string' || !description.trim()) {
        res.status(400).json({ error: 'Voice description is required' });
        return;
      }

      if (defaultPace !== undefined && !VALID_PACES.includes(defaultPace)) {
        res.status(400).json({
          error: `Invalid default pace: "${defaultPace}". Must be one of: slow, calm, natural, lively`,
        });
        return;
      }

      let previewWavBuffer: Buffer | undefined;
      if (typeof previewAudioBase64 === 'string' && previewAudioBase64.trim()) {
        const cleanB64 = previewAudioBase64.trim().replace(/^data:audio\/.*?;base64,/i, '');
        previewWavBuffer = Buffer.from(cleanB64, 'base64');
        if (previewWavBuffer.length > 2 * 1024 * 1024) {
          res.status(400).json({ error: 'previewAudioBase64 exceeds maximum 2MB limit' });
          return;
        }
        if (
          previewWavBuffer.length < 12 ||
          previewWavBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
          previewWavBuffer.toString('ascii', 8, 12) !== 'WAVE'
        ) {
          res.status(400).json({ error: 'previewAudioBase64 must be a WAV file' });
          return;
        }
      }

      try {
        const created = await ttsService.createAndSaveVoice({
          label: label.trim(),
          description: description.trim(),
          languageCode: typeof languageCode === 'string' ? languageCode.trim() : undefined,
          tags: Array.isArray(tags) ? tags : undefined,
          defaultPace,
          stagedGeminiVoiceName:
            typeof stagedGeminiVoiceName === 'string'
              ? stagedGeminiVoiceName.trim()
              : undefined,
          previewWavBuffer,
        });

        res.status(201).json(created);
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // PATCH /api/admin/voices/:id — update voice metadata (label, description, tags, defaultPace)
  router.patch(
    '/voices/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      try {
        validateSlug(id, 'voiceId');
      } catch {
        res.status(400).json({ error: `Invalid voice id: "${id}"` });
        return;
      }

      const { label, description, tags, defaultPace } = req.body || {};

      if (defaultPace !== undefined && !VALID_PACES.includes(defaultPace)) {
        res.status(400).json({
          error: `Invalid default pace: "${defaultPace}". Must be one of: slow, calm, natural, lively`,
        });
        return;
      }

      try {
        const updated = await ttsService.updateVoice(id, {
          label: typeof label === 'string' ? label : undefined,
          description: typeof description === 'string' ? description : undefined,
          tags: Array.isArray(tags) ? tags : undefined,
          defaultPace,
        });

        res.json(updated);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // DELETE /api/admin/voices/draft/:geminiVoiceName — discard unsaved staged draft voice
  // NOTE: Mounted before /voices/:id so "draft" is not interpreted as an :id slug!
  // Matches both bare IDs (voice_123) and prefixed IDs (voices/voice_123).
  router.delete(
    ['/voices/draft/:geminiVoiceName(*)', '/voices/draft/:geminiVoiceName'],
    asyncHandler(async (req: Request, res: Response) => {
      const geminiVoiceName = req.params.geminiVoiceName || (req.params as any)[0];
      try {
        await ttsService.discardDraftVoice(geminiVoiceName);
        res.json({ ok: true });
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  // DELETE /api/admin/voices/:id — delete custom voice (rejects prebuilt system voices)
  router.delete(
    '/voices/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      try {
        validateSlug(id, 'voiceId');
      } catch {
        res.status(400).json({ error: `Invalid voice id: "${id}"` });
        return;
      }

      try {
        const result = await ttsService.deleteVoice(id);
        res.json({ ok: true, deletedId: result.deletedId });
      } catch (err: unknown) {
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof ValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  return router;
}
