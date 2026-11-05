import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { LocalStorageAdapter, GcsStorageAdapter } from './storage/index.js';

const config = loadConfig();

const storage = config.gcsBucketName
  ? new GcsStorageAdapter(config.gcsBucketName)
  : new LocalStorageAdapter(config.dataDir);

const app = createApp({ config, storage });

app.listen(config.port, () => {
  console.log(`Storyteller Studio running on port ${config.port} in ${config.nodeEnv} mode`);
});
