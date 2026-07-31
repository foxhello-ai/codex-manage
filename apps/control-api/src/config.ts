import type { SystemConfigRecord } from "./domain";

export type ControlConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  adminOrigin: string;
  publicDomain: string;
  publicApiBaseUrl: string;
  allowDebugCodes: boolean;
  emailWebhookUrl: string | null;
  smsWebhookUrl: string | null;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  deviceTokenTtlSeconds: number;
  verificationCodeTtlSeconds: number;
  desktop: {
    apiBaseUrl: string;
    updateFeedUrl: string;
    managedDomainSuffixes: string[];
    configTtlSeconds: number;
  };
  cloudflare: {
    apiToken: string | null;
    accountId: string | null;
    zoneId: string | null;
  };
};

export function loadControlConfig(): ControlConfig {
  const publicApiBaseUrl = normalizeUrl(process.env.CONTROL_PUBLIC_API_BASE_URL ?? "https://codex-api.foxhello.com");
  const publicDomain = process.env.CONTROL_DEVICE_DOMAIN ?? "foxhello.com";
  return {
    host: process.env.CONTROL_HOST ?? "127.0.0.1",
    port: readInteger(process.env.CONTROL_PORT, 4320),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://codex_manage:codex_manage@127.0.0.1:5432/codex_manage",
    adminOrigin: process.env.CONTROL_ADMIN_ORIGIN ?? "https://codex-admin.foxhello.com",
    publicDomain,
    publicApiBaseUrl,
    allowDebugCodes: process.env.CONTROL_ALLOW_DEBUG_CODES === "true",
    emailWebhookUrl: process.env.CONTROL_EMAIL_WEBHOOK_URL ?? null,
    smsWebhookUrl: process.env.CONTROL_SMS_WEBHOOK_URL ?? null,
    accessTokenTtlSeconds: readInteger(process.env.CONTROL_ACCESS_TOKEN_TTL_SECONDS, 15 * 60),
    refreshTokenTtlSeconds: readInteger(process.env.CONTROL_REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60),
    deviceTokenTtlSeconds: readInteger(process.env.CONTROL_DEVICE_TOKEN_TTL_SECONDS, 60 * 60),
    verificationCodeTtlSeconds: readInteger(process.env.CONTROL_VERIFICATION_TTL_SECONDS, 10 * 60),
    desktop: {
      apiBaseUrl: publicApiBaseUrl,
      updateFeedUrl: normalizeUrl(process.env.CONTROL_DESKTOP_UPDATE_FEED_URL ?? `${publicApiBaseUrl}/updates/stable`),
      managedDomainSuffixes: readManagedDomainSuffixes(process.env.CONTROL_MANAGED_DOMAIN_SUFFIXES, publicDomain),
      configTtlSeconds: readInteger(process.env.CONTROL_DESKTOP_CONFIG_TTL_SECONDS, 60 * 60)
    },
    cloudflare: {
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? null,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
      zoneId: process.env.CLOUDFLARE_ZONE_ID ?? null
    }
  };
}

export function fallbackSystemConfig(config: ControlConfig): SystemConfigRecord {
  return {
    publicApiBaseUrl: normalizeHttpUrl(config.publicApiBaseUrl),
    desktopUpdateFeedUrl: normalizeHttpUrl(config.desktop.updateFeedUrl),
    deviceDomain: normalizeDomainSuffix(config.publicDomain),
    managedDomainSuffixes: normalizeDomainSuffixes(config.desktop.managedDomainSuffixes, config.publicDomain),
    adminOrigins: normalizeOrigins(config.adminOrigin.split(",")),
    desktopConfigTtlSeconds: normalizeTtlSeconds(config.desktop.configTtlSeconds),
    cloudflareZoneId: normalizeCloudflareZoneId(config.cloudflare.zoneId),
    updatedAt: null,
    updatedByAdminId: null
  };
}

export function normalizeSystemConfigInput(input: {
  publicApiBaseUrl: string;
  desktopUpdateFeedUrl: string;
  deviceDomain: string;
  managedDomainSuffixes: string[];
  adminOrigins: string[];
  desktopConfigTtlSeconds: number;
  cloudflareZoneId: string | null;
}): Omit<SystemConfigRecord, "updatedAt" | "updatedByAdminId"> {
  const deviceDomain = normalizeDomainSuffix(input.deviceDomain);
  if (!isValidDomainSuffix(deviceDomain)) {
    throw new Error("设备根域名格式不正确");
  }
  return {
    publicApiBaseUrl: normalizeHttpUrl(input.publicApiBaseUrl),
    desktopUpdateFeedUrl: normalizeHttpUrl(input.desktopUpdateFeedUrl),
    deviceDomain,
    managedDomainSuffixes: normalizeDomainSuffixes(input.managedDomainSuffixes, deviceDomain),
    adminOrigins: normalizeOrigins(input.adminOrigins),
    desktopConfigTtlSeconds: normalizeTtlSeconds(input.desktopConfigTtlSeconds),
    cloudflareZoneId: normalizeCloudflareZoneId(input.cloudflareZoneId)
  };
}

export function mergeSystemConfig(
  fallback: SystemConfigRecord,
  stored: SystemConfigRecord | null
): SystemConfigRecord {
  if (!stored) return fallback;
  return {
    publicApiBaseUrl: stored.publicApiBaseUrl || fallback.publicApiBaseUrl,
    desktopUpdateFeedUrl: stored.desktopUpdateFeedUrl || fallback.desktopUpdateFeedUrl,
    deviceDomain: stored.deviceDomain || fallback.deviceDomain,
    managedDomainSuffixes: stored.managedDomainSuffixes.length ? stored.managedDomainSuffixes : fallback.managedDomainSuffixes,
    adminOrigins: stored.adminOrigins.length ? stored.adminOrigins : fallback.adminOrigins,
    desktopConfigTtlSeconds: stored.desktopConfigTtlSeconds || fallback.desktopConfigTtlSeconds,
    cloudflareZoneId: stored.cloudflareZoneId || fallback.cloudflareZoneId,
    updatedAt: stored.updatedAt,
    updatedByAdminId: stored.updatedByAdminId
  };
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && allowedOrigins.includes(normalized));
}

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeHttpUrl(value: string): string {
  const normalized = normalizeUrl(value);
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("URL 仅支持 http/https");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function readManagedDomainSuffixes(value: string | undefined, publicDomain: string): string[] {
  const configured = value?.split(",") ?? [];
  return normalizeDomainSuffixes(configured, publicDomain);
}

function normalizeDomainSuffixes(values: string[], requiredDomain: string): string[] {
  const suffixes = values.map((item) => normalizeDomainSuffix(item)).filter(Boolean);
  const normalizedRequiredDomain = normalizeDomainSuffix(requiredDomain);
  if (normalizedRequiredDomain && !suffixes.includes(normalizedRequiredDomain)) {
    suffixes.push(normalizedRequiredDomain);
  }
  const unique = Array.from(new Set(suffixes));
  if (unique.some((suffix) => !isValidDomainSuffix(suffix))) {
    throw new Error("托管域名后缀格式不正确");
  }
  return unique;
}

function normalizeDomainSuffix(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
}

function normalizeOrigins(values: string[]): string[] {
  const origins = values.map((item) => normalizeOrigin(item)).filter(Boolean);
  if (!origins.length) throw new Error("至少需要一个后台访问 Origin");
  return Array.from(new Set(origins));
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("后台 Origin 仅支持 http/https");
  }
  return parsed.origin;
}

function normalizeTtlSeconds(value: number): number {
  if (!Number.isFinite(value)) return 3600;
  return Math.max(60, Math.min(24 * 60 * 60, Math.floor(value)));
}

function isValidDomainSuffix(value: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(value);
}

function normalizeCloudflareZoneId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(normalized)) {
    throw new Error("Cloudflare Zone ID 格式不正确");
  }
  return normalized;
}
