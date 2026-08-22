import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { loadConfig } from "./config";
import { registerAuthHook } from "./auth/hooks";
import { registerAuthRoutes } from "./routes/auth";
import { registerConfigRoutes } from "./routes/config";
import { registerModelRoutes } from "./routes/models";
import { registerRuntimeRoutes } from "./routes/runtime";
import { registerSessionRoutes } from "./routes/sessions";
import { registerCollaborationRoutes } from "./routes/collaboration";
import { AppRuntime } from "./services/AppRuntime";
import { CodexConfigWatcher, type CodexConfigChange } from "./services/CodexConfigWatcher";
import { SessionService } from "./services/SessionService";
import { SessionMetadataStore } from "./services/SessionMetadataStore";
import { JsonlSessionParser } from "./services/JsonlSessionParser";
import { ModelCatalogService } from "./services/ModelCatalogService";
import { SessionModelService } from "./services/SessionModelService";
import { registerStaticClient } from "./staticClient";
import { CollaborationStore } from "./services/CollaborationStore";

const config = loadConfig();

const app = Fastify({
  logger: true
});
const runtime = new AppRuntime(config);
const metadataStore = new SessionMetadataStore(config.metadataFile);
const collaborationStore = new CollaborationStore(
  config.collaborationFile ?? ".codex-manage/collaboration.json",
  { displayName: config.ownerName, localEmail: config.ownerEmail }
);
const modelCatalog = new ModelCatalogService(runtime.appServer);
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


await app.register(cookie, {
  secret: config.sessionSecret
});
await app.register(websocket);

registerAuthHook(app, collaborationStore);
registerAuthRoutes(app, config, collaborationStore);
registerCollaborationRoutes(app, collaborationStore);
registerConfigRoutes(app, config, () => runtime.getSnapshot());
registerModelRoutes(app, modelCatalog);
registerRuntimeRoutes(app, runtime, modelCatalog);
registerSessionRoutes(app, sessionService, jsonlSessionParser, runtime.runtimeManager, sessionModelService, collaborationStore);

if (process.env.NODE_ENV === "production") {
  await registerStaticClient(app, config.clientDir);
}

app.addHook("onClose", async () => {
  codexConfigWatcher.stop();
  if (runtimeReloadRetryTimer) clearTimeout(runtimeReloadRetryTimer);
  await runtime.stop();
});

try {
  await runtime.start();
  codexConfigWatcher.start();

  await app.listen({
    host: config.host,
    port: config.port
  });
  void modelCatalog.list().catch((error) => {
    app.log.warn({ err: error }, "Failed to prewarm model catalog");
  });
} catch (error) {
  app.log.error(error);
  codexConfigWatcher.stop();
  if (runtimeReloadRetryTimer) clearTimeout(runtimeReloadRetryTimer);
  await runtime.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
  process.exit(1);
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

function runtimeReloadRetryDelayMs(attempt: number, blocked: boolean): number {
  if (blocked) return Math.min(60_000, 5_000 * Math.max(1, attempt));
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}
