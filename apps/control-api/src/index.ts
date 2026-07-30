import { randomUUID } from "node:crypto";
import { createControlApp } from "./app";
import { createPaymentService } from "./billing/createPaymentService";
import { CloudflareAdapter } from "./cloudflare/CloudflareAdapter";
import { loadControlConfig } from "./config";
import { hashPassword } from "./security";
import { createPool } from "./db/pool";
import { PgControlStore } from "./db/PgControlStore";
import { WebhookVerificationNotifier } from "./notifier";

const config = loadControlConfig();
const pool = createPool(config.databaseUrl);
const store = new PgControlStore(pool);
const paymentService = createPaymentService(config, pool);
const cloudflare = config.cloudflare.apiToken && config.cloudflare.accountId && config.cloudflare.zoneId
  ? new CloudflareAdapter(config.cloudflare.apiToken, config.cloudflare.accountId, config.cloudflare.zoneId)
  : null;
const notifier = new WebhookVerificationNotifier(
  config.emailWebhookUrl,
  config.smsWebhookUrl,
  config.allowDebugCodes
);
const { app, service } = await createControlApp(config, store, notifier, cloudflare, paymentService);

const bootstrapEmail = process.env.CONTROL_BOOTSTRAP_ADMIN_EMAIL;
const bootstrapPassword = process.env.CONTROL_BOOTSTRAP_ADMIN_PASSWORD;
if (bootstrapEmail && bootstrapPassword) {
  await store.ensureAdmin({
    id: randomUUID(),
    email: bootstrapEmail.trim().toLowerCase(),
    passwordHash: hashPassword(bootstrapPassword),
    role: "admin"
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
