import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createStorageAdapter } from './storage/index.js';
import { defaultJobManager } from './services/jobManager.js';

const config = loadConfig();
const storage = createStorageAdapter(config);

defaultJobManager.setStorage(storage);
defaultJobManager
  .reconcileStaleJobs()
  .then((count) => {
    if (count > 0) {
      console.log(`[JobManager] Reconciled ${count} stale job(s) from prior run`);
    }
  })
  .catch((err) => {
    console.warn('[JobManager] Startup stale job reconciliation error:', err);
  });

const app = createApp({ config, storage, jobManager: defaultJobManager });

const server = app.listen(config.port, () => {
  console.log(`Storyteller Studio running on port ${config.port} in ${config.nodeEnv} mode`);
});

let isShuttingDown = false;
const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Server] Received ${signal}, starting graceful shutdown...`);

  const timeoutTimer = setTimeout(() => {
    console.error('[Server] Graceful shutdown timed out, force exiting.');
    process.exit(1);
  }, 5000);
  timeoutTimer.unref();

  try {
    const interrupted = await defaultJobManager.markRunningJobsInterrupted(
      'Interrupted by server shutdown/deploy'
    );
    if (interrupted > 0) {
      console.log(`[JobManager] Marked ${interrupted} running job(s) interrupted.`);
    }
  } catch (err) {
    console.error('[JobManager] Error marking running jobs interrupted during shutdown:', err);
  }

  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
