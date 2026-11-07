import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import { createRequireAdminMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { GeminiStoryService } from '../services/geminiStory.js';

export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/aac',
]);

export const MAX_TRANSCRIBE_AUDIO_BYTES = 8 * 1024 * 1024; // 8MB

export function createAdminTranscribeRouter(
  config: AppConfig,
  storyService: GeminiStoryService
): Router {
  const router = Router();
  const requireAdmin = createRequireAdminMiddleware(config);

  router.use(requireAdmin);

  // POST /api/admin/transcribe — multimodal speech-to-text dictation via gemini-3.8-flash
  router.post(
    '/transcribe',
    asyncHandler(async (req: Request, res: Response) => {
      const { audioBase64, mimeType, contextHint } = req.body || {};

      if (!audioBase64 || typeof audioBase64 !== 'string' || !audioBase64.trim()) {
        res.status(400).json({ error: 'audioBase64 is required and must be a non-empty string' });
        return;
      }

      if (!mimeType || typeof mimeType !== 'string' || !mimeType.trim()) {
        res.status(400).json({ error: 'mimeType is required and must be a non-empty string' });
        return;
      }

      // Strip any data:audio/...;base64, prefix (including codec parameters e.g. data:audio/webm;codecs=opus;base64,)
      const cleanBase64 = audioBase64.trim().replace(/^data:audio\/.*?;base64,/i, '');
      const decodedBytes = Buffer.byteLength(cleanBase64, 'base64');

      if (decodedBytes === 0) {
        res.status(400).json({ error: 'audioBase64 must contain valid base64 audio data' });
        return;
      }

      if (decodedBytes > MAX_TRANSCRIBE_AUDIO_BYTES) {
        res.status(413).json({
          error: `Audio payload exceeds maximum 8MB limit (size: ${(decodedBytes / (1024 * 1024)).toFixed(2)}MB)`,
        });
        return;
      }

      // Validate audio MIME type and strip codec parameters (e.g. "audio/webm;codecs=opus" -> "audio/webm")
      const baseMime = mimeType.split(';')[0].trim().toLowerCase();
      if (!baseMime.startsWith('audio/') || !ALLOWED_AUDIO_MIME_TYPES.has(baseMime)) {
        res.status(400).json({
          error: `Unsupported audio MIME type: "${mimeType}". Allowed formats: ${Array.from(ALLOWED_AUDIO_MIME_TYPES).join(', ')}`,
        });
        return;
      }

      const text = await storyService.transcribeAudio({
        audioBase64: cleanBase64,
        mimeType: baseMime,
        contextHint: typeof contextHint === 'string' ? contextHint.trim() : undefined,
      });

      res.json({ text });
    })
  );

  return router;
}
