import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Both src/server and the bundled dist/server entry are two levels below the app root.
const appRoot = fileURLToPath(new URL("../../", import.meta.url));

export function readAppVersion(root = appRoot): string {
  try {
    const buildInfo = readFileSync(join(root, "build-info.txt"), "utf8");
    const version = /^version=v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m.exec(buildInfo)?.[1];
    if (version) return `v${version}`;
  } catch {
    // Source checkouts do not contain release metadata.
  }

  if (existsSync(join(root, ".git"))) {
    try {
      const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000
      }).trim();
      const commit = git(["rev-parse", "--short=7", "HEAD"]);
      const dirty = git(["status", "--porcelain", "--untracked-files=normal", "--", "src", "package.json", "package-lock.json", "vite.config.ts"]);
      return `源码版（${commit}${dirty ? "，本地修改" : ""}）`;
    } catch {
      // Missing Git must not prevent an otherwise usable server from starting.
    }
  }
  return "未知版本";
}
