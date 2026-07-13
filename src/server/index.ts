import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { loadConfig } from "./config";
import { registerAuthHook } from "./auth/hooks";
import { registerAuthRoutes } from "./routes/auth";
import { registerConfigRoutes } from "./routes/config";
import { AppRuntime } from "./services/AppRuntime";

const config = loadConfig();

const app = Fastify({
  logger: true
});
const runtime = new AppRuntime(config);

await app.register(cookie, {
  secret: config.sessionSecret
});

registerAuthHook(app);
registerAuthRoutes(app, config);
registerConfigRoutes(app, config, () => runtime.getSnapshot());

try {
  try {
    await runtime.start();
  } catch (error) {
    app.log.error({ err: error }, "Codex app-server startup failed");
  }

  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
