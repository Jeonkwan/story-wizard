import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import type { AppConfig } from '../config.js';

export const ADMIN_COOKIE_NAME = 'story_admin_session';

export interface AdminSessionPayload {
  email: string;
  exp: number; // timestamp ms
}

export type GoogleTokenVerifier = (
  idToken: string
) => Promise<{ email: string; email_verified: boolean }>;

export function createDefaultGoogleTokenVerifier(clientId: string): GoogleTokenVerifier {
  const client = new OAuth2Client(clientId);
  return async (idToken: string) => {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: clientId || undefined,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new Error('Invalid token payload: missing email');
    }
    return {
      email: payload.email,
      email_verified: Boolean(payload.email_verified),
    };
  };
}

export function signAdminSession(
  email: string,
  secret: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000
): string {
  const payload: AdminSessionPayload = {
    email: email.toLowerCase(),
    exp: Date.now() + maxAgeMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAdminSession(
  token: string | undefined,
  secret: string,
  adminEmail: string
): AdminSessionPayload | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as AdminSessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return null;
    }
    if (
      adminEmail &&
      payload.email.toLowerCase() !== adminEmail.toLowerCase()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function getAdminCookieOptions(config: AppConfig) {
  const isSecure = config.nodeEnv === 'production' || Boolean(process.env.K_SERVICE);
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: isSecure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

export function createRequireAdminMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookieToken = req.cookies?.[ADMIN_COOKIE_NAME];
    const session = verifyAdminSession(cookieToken, config.sessionSecret, config.adminGoogleEmail);

    if (!session) {
      res.status(401).json({ error: 'Unauthorized: Admin session required or invalid' });
      return;
    }

    (req as Request & { adminUser?: AdminSessionPayload }).adminUser = session;
    next();
  };
}
