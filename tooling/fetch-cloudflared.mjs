import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const manifestPath = process.env.CLOUDFLARED_MANIFEST
  ? resolve(process.env.CLOUDFLARED_MANIFEST)
  : join(root, "resources", "cloudflared", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const version = String(manifest.version ?? "").trim();
if (!/^\d{4}\.\d+\.\d+$/.test(version)) {
  throw new Error("cloudflared manifest must contain a fixed release version such as 2026.7.0");
}

const releaseBase = process.env.CLOUDFLARED_RELEASE_BASE
  ?? `https://github.com/cloudflare/cloudflared/releases/download/${version}`;
const outputDirectory = join(root, "resources", "cloudflared");
await mkdir(outputDirectory, { recursive: true });

const targets = [
  { output: "cloudflared-darwin-arm64", asset: "cloudflared-darwin-arm64.tgz", archive: true },
  { output: "cloudflared-darwin-x64", asset: "cloudflared-darwin-amd64.tgz", archive: true },
  { output: "cloudflared-win32-x64.exe", asset: "cloudflared-windows-amd64.exe", archive: false }
];

for (const target of targets) {
  const expected = manifest.files?.[target.output];
  if (!/^[a-f0-9]{64}$/i.test(expected ?? "")) {
    throw new Error(`Missing SHA-256 for ${target.output}`);
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cloudflared-download-"));
  try {
    const downloaded = join(temporaryDirectory, target.asset);
    await downloadWithRetry(`${releaseBase}/${target.asset}`, downloaded, target.asset);
    const output = join(outputDirectory, target.output);
    if (target.archive) {
      const extracted = join(temporaryDirectory, "extracted");
      await mkdir(extracted);
      await run("tar", ["-xzf", downloaded, "-C", extracted]);
      const extractedBinary = join(extracted, "cloudflared");
      await verifySha256(extractedBinary, expected, target.output);
      await cp(extractedBinary, output);
    } else {
      await verifySha256(downloaded, expected, target.output);
      await cp(downloaded, output);
    }
    if (!target.output.endsWith(".exe")) await chmod(output, 0o755);
    console.info(`Prepared ${basename(output)} (${version})`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifySha256(path, expected, label) {
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${label}: expected ${expected}, received ${actual}`);
  }
}

async function run(command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function downloadWithRetry(url, destination, asset) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`Failed to download ${asset} after 4 attempts`, { cause: lastError });
}
