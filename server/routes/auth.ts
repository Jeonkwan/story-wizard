import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import {
  ADMIN_COOKIE_NAME,
  signAdminSession,
  verifyAdminSession,
  getAdminCookieOptions,
  createRequireAdminMiddleware,
  type GoogleTokenVerifier,
} from '../middleware/auth.js';

export function createAuthRouter(
  config: AppConfig,
  storage: StorageAdapter,
  verifyGoogleIdToken: GoogleTokenVerifier
): Router {
  const router = Router();
  const requireAdmin = createRequireAdminMiddleware(config);

  router.post('/login', async (req: Request, res: Response) => {
    const { idToken, devBypass } = req.body || {};

    if (devBypass === true) {
      if (!config.allowDevBypass) {
        res.status(401).json({ error: 'Dev bypass is disabled in this environment' });
        return;
      }
      const adminEmail = config.adminGoogleEmail || 'admin@storyteller.local';
      const token = signAdminSession(adminEmail, config.sessionSecret);
      res.cookie(ADMIN_COOKIE_NAME, token, getAdminCookieOptions(config));
      res.json({ ok: true, email: adminEmail });
      return;
    }

    if (!idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'Missing required idToken or devBypass flag' });
      return;
    }

    try {
      const payload = await verifyGoogleIdToken(idToken);
      if (!payload.email_verified) {
        res.status(403).json({ error: 'Google email is not verified' });
        return;
      }

      if (
        config.adminGoogleEmail &&
        payload.email.toLowerCase() !== config.adminGoogleEmail.toLowerCase()
      ) {
        res.status(403).json({ error: 'Access denied: account not authorized for admin access' });
        return;
      }

      const token = signAdminSession(payload.email, config.sessionSecret);
      res.cookie(ADMIN_COOKIE_NAME, token, getAdminCookieOptions(config));
      res.json({ ok: true, email: payload.email });
    } catch {
      res.status(401).json({ error: 'Invalid Google ID token' });
    }
  });

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(ADMIN_COOKIE_NAME, {
      ...getAdminCookieOptions(config),
      maxAge: 0,
    });
    res.json({ ok: true });
  });

  router.get('/me', (req: Request, res: Response) => {
    const cookieToken = req.cookies?.[ADMIN_COOKIE_NAME];
    const session = verifyAdminSession(cookieToken, config.sessionSecret, config.adminGoogleEmail);

    res.json({
      authenticated: Boolean(session),
      email: session?.email,
      devBypassEnabled: config.allowDevBypass,
    });
  });

  // Admin probe route for Phase 1 verification: returns all stories in catalog including drafts
  router.get('/stories', requireAdmin, async (_req: Request, res: Response) => {
    const catalog = await storage.getCatalog();
    res.json(catalog);
  });

  return router;
}
