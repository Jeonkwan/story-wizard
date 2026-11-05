import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import {
  type StorageAdapter,
  LocalStorageAdapter,
  InvalidSlugError,
  StorageNotFoundError,
} from './storage/index.js';
import {
  createDefaultGoogleTokenVerifier,
  type GoogleTokenVerifier,
} from './middleware/auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createPublicRouter } from './routes/public.js';

export interface CreateAppOptions {
  config?: AppConfig;
  storage?: StorageAdapter;
  verifyGoogleIdToken?: GoogleTokenVerifier;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const config = options.config || loadConfig();
  const storage = options.storage || new LocalStorageAdapter(config.dataDir);
  const verifyGoogleIdToken =
    options.verifyGoogleIdToken ||
    createDefaultGoogleTokenVerifier(config.googleClientId);

  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  // Mount API routers
  app.use('/api', createPublicRouter(config, storage));
  app.use('/api/admin', createAuthRouter(config, storage, verifyGoogleIdToken));

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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      if (err instanceof InvalidSlugError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof StorageNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      res.status(500).json({ error: message });
    }
  );

  return app;
}
