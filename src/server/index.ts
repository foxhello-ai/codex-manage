import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { loadConfig } from "./config";
import { registerAuthHook } from "./auth/hooks";
import { registerAuthRoutes } from "./routes/auth";
import { registerConfigRoutes } from "./routes/config";

const config = loadConfig();

const app = Fastify({
  logger: true
});

await app.register(cookie, {
  secret: config.sessionSecret
});

registerAuthHook(app);
registerAuthRoutes(app, config);
registerConfigRoutes(app, config);

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
