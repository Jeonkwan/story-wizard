import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createStorageAdapter } from './storage/index.js';

const config = loadConfig();
const storage = createStorageAdapter(config);

const app = createApp({ config, storage });

app.listen(config.port, () => {
  console.log(`Storyteller Studio running on port ${config.port} in ${config.nodeEnv} mode`);
});
