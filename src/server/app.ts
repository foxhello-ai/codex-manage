import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthHook } from "./auth/hooks";
import { LocalAuthService } from "./auth/LocalAuthService";
import type { AppConfig } from "./config";
import { registerAuthRoutes } from "./routes/auth";
import { registerConfigRoutes } from "./routes/config";
import { registerDesktopRoutes } from "./routes/desktop";
import { registerModelRoutes } from "./routes/models";
import { registerSessionRoutes } from "./routes/sessions";
import { AppRuntime } from "./services/AppRuntime";
import { JsonlSessionParser } from "./services/JsonlSessionParser";
import { ModelCatalogService } from "./services/ModelCatalogService";
import { SessionMetadataStore } from "./services/SessionMetadataStore";
import { SessionModelService } from "./services/SessionModelService";
import { SessionService } from "./services/SessionService";
import { registerRequestSecurityHook } from "./security/requestSecurity";
import { registerStaticClient } from "./staticClient";

export type LocalWebApplication = {
  app: FastifyInstance;
  runtime: AppRuntime;
};

export type CreateLocalWebApplicationOptions = {
  logger?: boolean;
  serveStatic?: boolean;
};

export async function createLocalWebApplication(
  config: AppConfig,
  options: CreateLocalWebApplicationOptions = {}
): Promise<LocalWebApplication> {
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: (address) => isLoopbackAddress(address)
  });
  const runtime = new AppRuntime(config);
  const authService = new LocalAuthService({
    databaseFile: config.localDatabaseFile,
    bootstrapPassword: config.runtimeMode === "desktop" && config.defaultPassword ? null : config.password,
    bootstrapPasswordIsDefault: config.defaultPassword,
    sessionTtlSeconds: config.sessionTtlSeconds,
    pairingCodeTtlSeconds: config.pairingCodeTtlSeconds
  });
  const metadataStore = new SessionMetadataStore(config.metadataFile);
  const modelCatalog = new ModelCatalogService(runtime.appServer);
  const jsonlSessionParser = new JsonlSessionParser(config.sessionsDir);
  const sessionService = new SessionService(
    runtime.appServer,
    metadataStore,
    jsonlSessionParser,
    modelCatalog,
    runtime.runtimeManager
  );
  const sessionModelService = new SessionModelService(
    modelCatalog,
    metadataStore,
    jsonlSessionParser,
    runtime.runtimeManager
  );

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(websocket);

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
  });

  registerRequestSecurityHook(app, config);
  registerAuthHook(app, authService, config.desktopControlToken);
  registerAuthRoutes(app, config, authService);
  if (config.runtimeMode === "desktop" && config.desktopControlToken) {
    registerDesktopRoutes(app, authService);
  }
  registerConfigRoutes(app, config, () => runtime.getSnapshot(), () => authService.isDefaultPassword());
  registerModelRoutes(app, modelCatalog);
  registerSessionRoutes(
    app,
    sessionService,
    jsonlSessionParser,
    runtime.runtimeManager,
    sessionModelService,
    authService
  );

  if (options.serveStatic ?? process.env.NODE_ENV === "production") {
    await registerStaticClient(app, config.clientDir);
  }

  app.addHook("onClose", async () => {
    await runtime.stop();
    authService.close();
  });

  return { app, runtime };
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
