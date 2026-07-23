import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TunnelSupervisor } from "./TunnelSupervisor";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("TunnelSupervisor", () => {
  it("extracts a Quick Tunnel URL and stops cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-tunnel-supervisor-"));
    directories.push(directory);
    const binary = join(directory, "fake-cloudflared");
    const argsFile = join(directory, "args.txt");
    await writeFile(binary, `#!/bin/sh
printf '%s\n' "$@" > '${argsFile}'
echo '{"message":"Your quick Tunnel has been created! Visit it at https://quiet-tree.trycloudflare.com"}' 1>&2
trap 'exit 0' TERM INT
while true; do sleep 1; done
`);
    await chmod(binary, 0o755);

    const supervisor = new TunnelSupervisor({
      binaryPath: binary,
      runtimeDirectory: join(directory, "runtime")
    });
    const online = new Promise<void>((resolve) => {
      supervisor.on("status", (snapshot) => {
        if (snapshot.state === "online") resolve();
      });
    });

    await supervisor.startQuick("http://127.0.0.1:4310");
    await online;

    expect(supervisor.getSnapshot()).toMatchObject({
      state: "online",
      publicUrl: "https://quiet-tree.trycloudflare.com"
    });
    const argumentsText = await readFile(argsFile, "utf8");
    expect(argumentsText).not.toContain("--logformat");
    expect(argumentsText).toContain("--url\nhttp://127.0.0.1:4310");
    await supervisor.stop();
    expect(supervisor.getSnapshot().state).toBe("stopped");
  });

  it("passes a Named Tunnel token through a restricted token file instead of process arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-named-tunnel-"));
    directories.push(directory);
    const binary = join(directory, "fake-cloudflared");
    const argsFile = join(directory, "args.txt");
    const capturedToken = join(directory, "captured-token.txt");
    await writeFile(binary, `#!/bin/sh
printf '%s\n' "$@" > '${argsFile}'
previous=''
for value in "$@"; do
  if [ "$previous" = '--token-file' ]; then cp "$value" '${capturedToken}'; fi
  previous="$value"
done
echo '{"message":"Registered tunnel connection"}' 1>&2
trap 'exit 0' TERM INT
while true; do sleep 1; done
`);
    await chmod(binary, 0o755);
    const runtimeDirectory = join(directory, "runtime");
    const supervisor = new TunnelSupervisor({ binaryPath: binary, runtimeDirectory });
    const online = new Promise<void>((resolve) => {
      supervisor.on("status", (snapshot) => {
        if (snapshot.state === "online") resolve();
      });
    });

    await supervisor.startNamed("named-secret-token", "https://d-test.xmwefun.cn");
    await online;

    const argumentsText = await readFile(argsFile, "utf8");
    expect(argumentsText).not.toContain("named-secret-token");
    expect(argumentsText).not.toContain("--logformat");
    expect(argumentsText).toContain("--token-file");
    expect(await readFile(capturedToken, "utf8")).toBe("named-secret-token");
    await supervisor.stop();
    await expect(access(join(runtimeDirectory, "named-tunnel-token"))).rejects.toBeDefined();
  });

  it("reports cloudflared usage diagnostics when the process exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-manage-tunnel-diagnostic-"));
    directories.push(directory);
    const binary = join(directory, "fake-cloudflared");
    await writeFile(binary, `#!/bin/sh
echo 'Incorrect Usage. flag provided but not defined: -logformat' 1>&2
exit 0
`);
    await chmod(binary, 0o755);

    const supervisor = new TunnelSupervisor({
      binaryPath: binary,
      runtimeDirectory: join(directory, "runtime")
    });
    const reconnecting = new Promise<string>((resolve) => {
      supervisor.on("status", (snapshot) => {
        if (snapshot.state === "reconnecting" && snapshot.error) resolve(snapshot.error);
      });
    });

    await supervisor.startQuick("http://127.0.0.1:4310");
    await expect(reconnecting).resolves.toContain("Incorrect Usage");
    await supervisor.stop();
  });
});
