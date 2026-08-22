import { loadConfig } from "./config";
import { startLocalWebServer } from "./start";
const config = loadConfig();
try {
  await startLocalWebServer(config);
} catch (error) {
  console.error(error);
  process.exit(1);
}
