import { loadConfig } from "./config";
import { startLocalWebServer } from "./start";

async function main() {
  const config = loadConfig({ runtimeMode: "desktop", host: "127.0.0.1" });
  const server = await startLocalWebServer(config, { logger: true, serveStatic: true });

  process.stdout.write(`CODEX_MANAGE_READY ${JSON.stringify({ host: server.host, port: server.port, url: server.url })}\n`);

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  process.on("disconnect", () => void close());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
