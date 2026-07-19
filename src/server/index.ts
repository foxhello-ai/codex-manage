import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { loadConfig } from "./config";
import { registerAuthHook } from "./auth/hooks";
import { registerAuthRoutes } from "./routes/auth";
import { registerConfigRoutes } from "./routes/config";
import { registerModelRoutes } from "./routes/models";
import { registerSessionRoutes } from "./routes/sessions";
import { AppRuntime } from "./services/AppRuntime";
import { SessionService } from "./services/SessionService";
import { SessionMetadataStore } from "./services/SessionMetadataStore";
import { JsonlSessionParser } from "./services/JsonlSessionParser";
import { ModelCatalogService } from "./services/ModelCatalogService";
import { registerStaticClient } from "./staticClient";

const config = loadConfig();

const app = Fastify({
  logger: true
});
const runtime = new AppRuntime(config);
const metadataStore = new SessionMetadataStore(config.metadataFile);
const modelCatalog = new ModelCatalogService(runtime.appServer);
const sessionService = new SessionService(runtime.appServer, metadataStore);
const jsonlSessionParser = new JsonlSessionParser(config.sessionsDir);

await app.register(cookie, {
  secret: config.sessionSecret
});
await app.register(websocket);

registerAuthHook(app);
registerAuthRoutes(app, config);
registerConfigRoutes(app, config, () => runtime.getSnapshot());
registerModelRoutes(app, modelCatalog);
registerSessionRoutes(app, sessionService, jsonlSessionParser, runtime.runtimeManager);

if (process.env.NODE_ENV === "production") {
  await registerStaticClient(app, config.clientDir);
}

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
