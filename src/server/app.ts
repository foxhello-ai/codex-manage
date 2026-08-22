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
import { registerRuntimeRoutes } from "./routes/runtime";
import { registerSessionRoutes } from "./routes/sessions";
import { registerCollaborationRoutes } from "./routes/collaboration";
import { AppRuntime } from "./services/AppRuntime";
import { CodexConfigWatcher, type CodexConfigChange } from "./services/CodexConfigWatcher";
import { JsonlSessionParser } from "./services/JsonlSessionParser";
import { ModelCatalogService } from "./services/ModelCatalogService";
import { SessionMetadataStore } from "./services/SessionMetadataStore";
import { SessionModelService } from "./services/SessionModelService";
import { SessionService } from "./services/SessionService";
import { CollaborationStore } from "./services/CollaborationStore";
import { registerRequestSecurityHook } from "./security/requestSecurity";
import { registerStaticClient } from "./staticClient";

export type LocalWebApplication = {
  app: FastifyInstance;
  runtime: AppRuntime;
  startBackgroundTasks: () => void;
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
  const collaborationStore = new CollaborationStore(config.collaborationFile, {
    displayName: config.ownerName,
    localEmail: config.ownerEmail
  });
  const metadataStore = new SessionMetadataStore(config.metadataFile);
  const modelCatalog = new ModelCatalogService(runtime.appServer);
  let backgroundTasksStarted = false;
  let runtimeReloadRetryAttempt = 0;
  let runtimeReloadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const codexConfigWatcher = new CodexConfigWatcher({
    onChange: (change) => handleCodexConfigChange(change)
  });
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
  registerAuthHook(app, authService, config.desktopControlToken, collaborationStore);
  registerAuthRoutes(app, config, authService, collaborationStore);
  registerCollaborationRoutes(app, collaborationStore);
  if (config.runtimeMode === "desktop" && config.desktopControlToken) {
    registerDesktopRoutes(app, authService);
  }
  registerConfigRoutes(app, config, () => runtime.getSnapshot(), () => authService.isDefaultPassword());
  registerModelRoutes(app, modelCatalog);
  registerRuntimeRoutes(app, runtime, modelCatalog);
  registerSessionRoutes(
    app,
    sessionService,
    jsonlSessionParser,
    runtime.runtimeManager,
    sessionModelService,
    authService,
    collaborationStore
  );

  if (options.serveStatic ?? process.env.NODE_ENV === "production") {
    await registerStaticClient(app, config.clientDir);
  }

  function startBackgroundTasks(): void {
    if (backgroundTasksStarted) return;
    backgroundTasksStarted = true;
    codexConfigWatcher.start();
    void modelCatalog.list().catch((error) => {
      app.log.warn({ err: error }, "Failed to prewarm model catalog");
    });
  }

  function handleCodexConfigChange(change: CodexConfigChange): void {
    runtimeReloadRetryAttempt = 0;
    const reason = `codex_config_changed:${change.signature.slice(0, 12)}`;
    app.log.info({ directory: change.directory, changedAt: change.changedAt }, "Codex config changed, scheduling app-server reload");
    scheduleRuntimeReload(reason, 1500);
  }

  function scheduleRuntimeReload(reason: string, delayMs: number): void {
    if (runtimeReloadRetryTimer) clearTimeout(runtimeReloadRetryTimer);
    runtimeReloadRetryTimer = setTimeout(() => {
      runtimeReloadRetryTimer = null;
      void reloadRuntimeAfterCodexConfigChange(reason);
    }, delayMs);
    runtimeReloadRetryTimer.unref?.();
  }

  async function reloadRuntimeAfterCodexConfigChange(reason: string): Promise<void> {
    try {
      const result = await runtime.reloadAppServer({ trigger: "config_watcher", reason });
      modelCatalog.invalidate();
      runtimeReloadRetryAttempt = 0;
      app.log.info({ generation: result.generation, reloadedAt: result.reloadedAt }, "Codex app-server reloaded after config change");
    } catch (error) {
      runtimeReloadRetryAttempt += 1;
      const blocked = error instanceof Error && error.name === "ModelDomainError" && "code" in error
        ? (error as { code?: string }).code === "RUNTIME_RELOAD_BLOCKED"
        : false;
      app.log.warn(
        { err: error, attempt: runtimeReloadRetryAttempt, blocked },
        blocked ? "Codex app-server reload blocked, retrying" : "Codex app-server reload failed, retrying"
      );
      scheduleRuntimeReload(reason, runtimeReloadRetryDelayMs(runtimeReloadRetryAttempt, blocked));
    }
  }

  app.addHook("onClose", async () => {
    codexConfigWatcher.stop();
    if (runtimeReloadRetryTimer) clearTimeout(runtimeReloadRetryTimer);
    runtimeReloadRetryTimer = null;
    await runtime.stop();
    authService.close();
  });

  return { app, runtime, startBackgroundTasks };
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function runtimeReloadRetryDelayMs(attempt: number, blocked: boolean): number {
  if (blocked) return Math.min(60_000, 5_000 * Math.max(1, attempt));
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}
