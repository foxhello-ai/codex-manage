import { readFileSync } from "node:fs";

export type ControlConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  adminOrigin: string;
  publicDomain: string;
  allowDebugCodes: boolean;
  emailWebhookUrl: string | null;
  smsWebhookUrl: string | null;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  deviceTokenTtlSeconds: number;
  verificationCodeTtlSeconds: number;
  billing: {
    orderExpiresInSeconds: number;
    offlinePayments: {
      enabled: boolean;
      secret: string | null;
    };
    wechat: {
      enabled: boolean;
      appId: string | null;
      merchantId: string | null;
      apiV3Key: string | null;
      privateKeyPem: string | null;
      certificateSerialNo: string | null;
      platformCertificatePem: string | null;
      notifyUrl: string | null;
      apiBaseUrl: string | null;
    };
    alipay: {
      enabled: boolean;
      appId: string | null;
      privateKeyPem: string | null;
      publicKeyPem: string | null;
      notifyUrl: string | null;
      gatewayUrl: string | null;
    };
  };
  cloudflare: {
    apiToken: string | null;
    accountId: string | null;
    zoneId: string | null;
  };
};

export function loadControlConfig(): ControlConfig {
  return {
    host: process.env.CONTROL_HOST ?? "127.0.0.1",
    port: readInteger(process.env.CONTROL_PORT, 4320),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://codex_manage:codex_manage@127.0.0.1:5432/codex_manage",
    adminOrigin: process.env.CONTROL_ADMIN_ORIGIN ?? "https://codex-admin.xmwefun.cn",
    publicDomain: process.env.CONTROL_DEVICE_DOMAIN ?? "xmwefun.cn",
    allowDebugCodes: process.env.CONTROL_ALLOW_DEBUG_CODES === "true",
    emailWebhookUrl: process.env.CONTROL_EMAIL_WEBHOOK_URL ?? null,
    smsWebhookUrl: process.env.CONTROL_SMS_WEBHOOK_URL ?? null,
    accessTokenTtlSeconds: readInteger(process.env.CONTROL_ACCESS_TOKEN_TTL_SECONDS, 15 * 60),
    refreshTokenTtlSeconds: readInteger(process.env.CONTROL_REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 60 * 60),
    deviceTokenTtlSeconds: readInteger(process.env.CONTROL_DEVICE_TOKEN_TTL_SECONDS, 60 * 60),
    verificationCodeTtlSeconds: readInteger(process.env.CONTROL_VERIFICATION_TTL_SECONDS, 10 * 60),
    billing: {
      orderExpiresInSeconds: readInteger(process.env.BILLING_ORDER_EXPIRES_SECONDS, 15 * 60),
      offlinePayments: {
        enabled: process.env.BILLING_OFFLINE_PAYMENTS === "true",
        secret: process.env.BILLING_OFFLINE_SECRET ?? null
      },
      wechat: {
        enabled: process.env.WECHAT_PAY_ENABLED === "true",
        appId: process.env.WECHAT_PAY_APP_ID ?? null,
        merchantId: process.env.WECHAT_PAY_MCH_ID ?? null,
        apiV3Key: process.env.WECHAT_PAY_API_V3_KEY ?? null,
        privateKeyPem: readSecret(process.env.WECHAT_PAY_PRIVATE_KEY, process.env.WECHAT_PAY_PRIVATE_KEY_FILE),
        certificateSerialNo: process.env.WECHAT_PAY_CERT_SERIAL_NO ?? null,
        platformCertificatePem: readSecret(process.env.WECHAT_PAY_PLATFORM_CERT, process.env.WECHAT_PAY_PLATFORM_CERT_FILE),
        notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL ?? null,
        apiBaseUrl: process.env.WECHAT_PAY_API_BASE_URL ?? null
      },
      alipay: {
        enabled: process.env.ALIPAY_ENABLED === "true",
        appId: process.env.ALIPAY_APP_ID ?? null,
        privateKeyPem: readSecret(process.env.ALIPAY_PRIVATE_KEY, process.env.ALIPAY_PRIVATE_KEY_FILE),
        publicKeyPem: readSecret(process.env.ALIPAY_PUBLIC_KEY, process.env.ALIPAY_PUBLIC_KEY_FILE),
        notifyUrl: process.env.ALIPAY_NOTIFY_URL ?? null,
        gatewayUrl: process.env.ALIPAY_GATEWAY_URL ?? null
      }
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

function readSecret(value: string | undefined, filePath: string | undefined): string | null {
  if (value) return value.replace(/\\n/g, "\n");
  if (!filePath) return null;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
