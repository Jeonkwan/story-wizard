import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import {
  type StorageAdapter,
  createStorageAdapter,
  InvalidSlugError,
  StorageNotFoundError,
} from './storage/index.js';
import {
  createDefaultGoogleTokenVerifier,
  type GoogleTokenVerifier,
} from './middleware/auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createAdminStoriesRouter } from './routes/adminStories.js';
import { createAdminVoicesRouter } from './routes/adminVoices.js';
import { createAdminTranscribeRouter } from './routes/adminTranscribe.js';
import { createAdminPodcastsRouter } from './routes/adminPodcasts.js';
import { createPublicRouter } from './routes/public.js';
import {
  GeminiStoryService,
  type StoryLLMProvider,
} from './services/geminiStory.js';
import {
  GeminiTtsService,
  type TtsProvider,
} from './services/geminiTts.js';
import type { M4aTranscoder } from './lib/m4a.js';
import { JobManager, defaultJobManager } from './services/jobManager.js';
import { ValidationError, ConflictError, NotFoundError } from './lib/validators.js';

export interface CreateAppOptions {
  config?: AppConfig;
  storage?: StorageAdapter;
  verifyGoogleIdToken?: GoogleTokenVerifier;
  storyLLMProvider?: StoryLLMProvider;
  storyService?: GeminiStoryService;
  ttsProvider?: TtsProvider;
  ttsService?: GeminiTtsService;
  m4aTranscoder?: M4aTranscoder;
  jobManager?: JobManager;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const config = options.config || loadConfig();
  const storage = options.storage || createStorageAdapter(config);
  const verifyGoogleIdToken =
    options.verifyGoogleIdToken ||
    createDefaultGoogleTokenVerifier(config.googleClientId);

  const storyService =
    options.storyService ||
    new GeminiStoryService(config, storage, options.storyLLMProvider);

  const ttsService =
    options.ttsService ||
    new GeminiTtsService(config, storage, options.ttsProvider, options.m4aTranscoder);

  const jobManager = options.jobManager || defaultJobManager;
  jobManager.setStorage(storage);

  const app = express();

  // Route-specific high-limit JSON parsers registered BEFORE global 1mb parser
  app.use('/api/admin/transcribe', express.json({ limit: '12mb' }));
  app.use('/api/admin/voices', express.json({ limit: '4mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Mount API routers
  app.use('/api', createPublicRouter(config, storage));
  app.use('/api/admin', createAuthRouter(config, storage, verifyGoogleIdToken));
  app.use('/api/admin', createAdminVoicesRouter(config, storage, ttsService));
  app.use('/api/admin', createAdminTranscribeRouter(config, storyService));
  app.use('/api/admin', createAdminPodcastsRouter(config, storage));
  app.use('/api/admin', createAdminStoriesRouter(config, storage, storyService, ttsService, jobManager));

  // Serve client static assets + SPA fallback ONLY if dist/client/index.html exists
  const clientDist = path.resolve('dist/client');
  const clientIndexHtml = path.join(clientDist, 'index.html');

  if (fs.existsSync(clientIndexHtml)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(clientIndexHtml);
    });
  }

  // Global Error Handler
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof InvalidSlugError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof NotFoundError || err instanceof StorageNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      res.status(500).json({ error: message });
    }
  );

  return app;
}
