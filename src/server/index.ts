import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = createApp({ config });

app.listen(config.port, () => {
  console.log(`FreeDrama Downloader server listening on http://localhost:${config.port}`);
  console.log(`Downloads directory: ${config.downloadsDir}`);
  console.log(`Batch concurrency: ${config.downloadConcurrency}`);
});
