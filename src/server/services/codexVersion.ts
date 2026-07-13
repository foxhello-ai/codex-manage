import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function detectCodexVersion(codexCliPath: string): Promise<string> {
  const { stdout } = await execFileAsync(codexCliPath, ["--version"], {
    timeout: 5000
  });

  return stdout.trim();
}
