type BrowserLocation = Pick<Location, "hostname" | "protocol">;

export function resolveApiBase(
  configuredBase: string | undefined,
  location: BrowserLocation,
  directPort = "4320"
): string {
  if (isDirectHost(location.hostname)) {
    const hostname = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname;
    return `${location.protocol}//${hostname}:${directPort}`;
  }
  return (configuredBase ?? "").replace(/\/$/, "");
}

function isDirectHost(hostname: string): boolean {
  return hostname === "localhost"
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname.includes(":");
}
