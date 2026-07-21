import { CloudflareAdapter } from "./cloudflare/CloudflareAdapter";
import { loadControlConfig } from "./config";
import { createPool } from "./db/pool";
import { PgControlStore } from "./db/PgControlStore";
import { TunnelProvisioner } from "./provisioner";

const config = loadControlConfig();
if (!config.cloudflare.apiToken || !config.cloudflare.accountId || !config.cloudflare.zoneId) {
  throw new Error("Cloudflare API configuration is required for the provisioning worker");
}

const store = new PgControlStore(createPool(config.databaseUrl));
const provisioner = new TunnelProvisioner(
  store,
  new CloudflareAdapter(
    config.cloudflare.apiToken,
    config.cloudflare.accountId,
    config.cloudflare.zoneId
  )
);

let closing = false;
let nextReconcileAt = 0;
async function loop() {
  while (!closing) {
    if (Date.now() >= nextReconcileAt) {
      await store.reconcileTunnelJobs().catch((error) => console.error(error));
      nextReconcileAt = Date.now() + 30_000;
    }
    const handled = await provisioner.runOnce().catch((error) => {
      console.error(error);
      return false;
    });
    if (!handled) await delay(2000);
  }
}

async function close() {
  closing = true;
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await loop();
await store.close();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
