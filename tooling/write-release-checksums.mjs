import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "apps/desktop/release");
const entries = await readdir(directory, { withFileTypes: true });
const artifacts = entries
  .filter((entry) => entry.isFile()
    && entry.name !== "SHA256SUMS.txt"
    && !entry.name.startsWith("._")
    && !entry.name.startsWith("builder-debug")
    && !entry.name.startsWith("builder-effective-config"))
  .sort((left, right) => left.name.localeCompare(right.name));

const lines = [];
for (const artifact of artifacts) {
  const file = resolve(directory, artifact.name);
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  lines.push(`${digest}  ${basename(file)}`);
}

if (lines.length === 0) throw new Error(`No release artifacts found in ${directory}`);
await writeFile(resolve(directory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
