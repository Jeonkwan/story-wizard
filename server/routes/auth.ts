import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { StorageAdapter } from '../storage/storageAdapter.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  ADMIN_COOKIE_NAME,
  signAdminSession,
  verifyAdminSession,
  getAdminCookieOptions,
  type GoogleTokenVerifier,
} from '../middleware/auth.js';

export function createAuthRouter(
  config: AppConfig,
  _storage: StorageAdapter,
  verifyGoogleIdToken: GoogleTokenVerifier
): Router {
  const router = Router();

  router.post(
    '/login',
    asyncHandler(async (req: Request, res: Response) => {
      const { idToken, devBypass } = req.body || {};

      if (devBypass === true) {
        if (!config.allowDevBypass) {
          res.status(401).json({ error: 'Dev bypass is disabled in this environment' });
          return;
        }
        const adminEmail = config.adminGoogleEmail.trim() || 'admin@storyteller.local';
        const token = signAdminSession(adminEmail, config.sessionSecret);
        res.cookie(ADMIN_COOKIE_NAME, token, getAdminCookieOptions(config));
        res.json({ ok: true, email: adminEmail });
        return;
      }

      if (!idToken || typeof idToken !== 'string') {
        res.status(400).json({ error: 'Missing required idToken or devBypass flag' });
        return;
      }

      // Security: fail closed if admin email is not configured
      const configuredAdminEmail = config.adminGoogleEmail.trim();
      if (!configuredAdminEmail) {
        res.status(403).json({ error: 'Admin email is not configured' });
        return;
      }

      try {
        const payload = await verifyGoogleIdToken(idToken);
        if (!payload.email_verified) {
          res.status(403).json({ error: 'Google email is not verified' });
          return;
        }

        if (payload.email.toLowerCase() !== configuredAdminEmail.toLowerCase()) {
          res.status(403).json({ error: 'Access denied: account not authorized for admin access' });
          return;
        }

        const token = signAdminSession(payload.email, config.sessionSecret);
        res.cookie(ADMIN_COOKIE_NAME, token, getAdminCookieOptions(config));
        res.json({ ok: true, email: payload.email });
      } catch {
        res.status(401).json({ error: 'Invalid Google ID token' });
      }
    })
  );

  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie(ADMIN_COOKIE_NAME, {
      ...getAdminCookieOptions(config),
      maxAge: 0,
    });
    res.json({ ok: true });
  });

  router.get('/me', (req: Request, res: Response) => {
    const cookieToken = req.cookies?.[ADMIN_COOKIE_NAME];
    const session = verifyAdminSession(cookieToken, config.sessionSecret, config);

    res.json({
      authenticated: Boolean(session),
      email: session?.email,
      devBypassEnabled: config.allowDevBypass,
      googleClientId: config.googleClientId,
    });
  });

  return router;
}
