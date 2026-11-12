import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAppVersion } from "./appVersion";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-manage-version-"));
  roots.push(root);
  // The repository package version is not the Runtime release version.
  writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
  return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("running application version", () => {
  it("uses the installed package's release metadata rather than package.json or the working directory", () => {
    const root = fixture();
    writeFileSync(join(root, "build-info.txt"), "version=1.0.11\nbuild_date=2026-11-12T00:00:00Z\n");
    expect(readAppVersion(root)).toBe("v1.0.11");
  });

  it("identifies source checkouts and local code changes without claiming a release version", () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init");
    git("add", "package.json");
    git("-c", "user.name=Version Test", "-c", "user.email=version@test.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    expect(readAppVersion(root)).toMatch(/^源码版（[0-9a-f]+）$/);
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0","changed":true}');
    expect(readAppVersion(root)).toMatch(/^源码版（[0-9a-f]+，本地修改）$/);
  });

  it("reports unknown when release metadata is absent or invalid, without using an enclosing repository", () => {
    const root = fixture();
    expect(readAppVersion(root)).toBe("未知版本");
    writeFileSync(join(root, "build-info.txt"), "version=not-a-release\n");
    expect(readAppVersion(root)).toBe("未知版本");
  });
});
