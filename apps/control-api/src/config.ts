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

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function readManagedDomainSuffixes(value: string | undefined, publicDomain: string): string[] {
  const configured = value?.split(",").map((item) => normalizeDomainSuffix(item)).filter(Boolean) ?? [];
  const suffixes = configured.length > 0 ? configured : [normalizeDomainSuffix(publicDomain)];
  const normalizedPublicDomain = normalizeDomainSuffix(publicDomain);
  if (normalizedPublicDomain && !suffixes.includes(normalizedPublicDomain)) {
    suffixes.push(normalizedPublicDomain);
  }
  return Array.from(new Set(suffixes));
}

function normalizeDomainSuffix(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
}
