import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Info.plist");
  await execFileAsync("/usr/bin/plutil", [
    "-replace",
    "NSAppTransportSecurity.NSAllowsArbitraryLoads",
    "-bool",
    "NO",
    plist
  ]);
}
