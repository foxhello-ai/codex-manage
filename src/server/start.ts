import type { AddressInfo } from "node:net";
import { createLocalWebApplication, type CreateLocalWebApplicationOptions } from "./app";
import type { AppConfig } from "./config";

export type StartedLocalWebServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export async function startLocalWebServer(
  config: AppConfig,
  options: CreateLocalWebApplicationOptions = {}
): Promise<StartedLocalWebServer> {
  const { app, runtime, startBackgroundTasks } = await createLocalWebApplication(config, options);

  await runtime.start();

  try {
    const url = await app.listen({ host: config.host, port: config.port });
    const address = app.server.address() as AddressInfo | null;
    startBackgroundTasks();

    return {
      host: config.host,
      port: address?.port ?? config.port,
      url,
      close: async () => {
        await app.close();
      }
    };
  } catch (error) {
    await runtime.stop();
    await app.close();
    throw error;
  }
}
