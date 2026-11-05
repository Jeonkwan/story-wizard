export interface AppConfig {
  port: number;
  nodeEnv: string;
  geminiApiKey: string;
  geminiTextModel: string;
  geminiTtsModel: string;
  geminiTtsLiteModel: string;
  gcsBucketName: string;
  dataDir: string;
  adminGoogleEmail: string;
  googleClientId: string;
  sessionSecret: string;
  allowDevBypass: boolean;
}

const DEFAULT_DEV_SECRET = 'dev-session-secret-must-be-at-least-32-chars-long!';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production' || Boolean(env.K_SERVICE);

  const sessionSecret = env.SESSION_SECRET || (isProd ? '' : DEFAULT_DEV_SECRET);

  if (isProd && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production or Cloud Run environment');
  }

  const allowDevBypass =
    env.NODE_ENV !== 'production' &&
    !env.K_SERVICE &&
    env.DEV_ADMIN_BYPASS === 'true';

  return {
    port: parseInt(env.PORT || '8080', 10),
    nodeEnv,
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiTextModel: env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash',
    geminiTtsModel: env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts',
    geminiTtsLiteModel: env.GEMINI_TTS_LITE_MODEL || 'gemini-3.8-flash-lite-tts',
    gcsBucketName: env.GCS_BUCKET_NAME || '',
    dataDir: env.DATA_DIR || './data',
    adminGoogleEmail: env.ADMIN_GOOGLE_EMAIL || '',
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    sessionSecret,
    allowDevBypass,
  };
}
