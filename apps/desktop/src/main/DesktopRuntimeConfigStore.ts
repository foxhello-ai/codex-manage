import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DesktopRuntimeConfig = {
  schemaVersion: number;
  apiBaseUrl: string;
  updateFeedUrl: string;
  managedDomainSuffixes: string[];
  configTtlSeconds: number;
  generatedAt: string;
  fetchedAt: string;
  sourceBaseUrl: string;
};

export class DesktopRuntimeConfigStore {
  constructor(private readonly file: string) {}

  load(): DesktopRuntimeConfig | null {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DesktopRuntimeConfig>;
      if (
        parsed.schemaVersion !== 1
        || typeof parsed.apiBaseUrl !== "string"
        || typeof parsed.updateFeedUrl !== "string"
        || !Array.isArray(parsed.managedDomainSuffixes)
        || typeof parsed.configTtlSeconds !== "number"
        || typeof parsed.generatedAt !== "string"
        || typeof parsed.fetchedAt !== "string"
        || typeof parsed.sourceBaseUrl !== "string"
      ) {
        return null;
      }
      const managedDomainSuffixes = parsed.managedDomainSuffixes
        .filter((value): value is string => typeof value === "string")
        .map(normalizeDomainSuffix)
        .filter(Boolean);
      if (!managedDomainSuffixes.length) return null;
      return {
        schemaVersion: 1,
        apiBaseUrl: normalizeUrl(parsed.apiBaseUrl),
        updateFeedUrl: normalizeUrl(parsed.updateFeedUrl),
        managedDomainSuffixes,
        configTtlSeconds: Math.max(60, Math.floor(parsed.configTtlSeconds)),
        generatedAt: parsed.generatedAt,
        fetchedAt: parsed.fetchedAt,
        sourceBaseUrl: normalizeUrl(parsed.sourceBaseUrl)
      };
    } catch {
      return null;
    }
  }

  save(config: DesktopRuntimeConfig): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

export function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeDomainSuffix(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
}
