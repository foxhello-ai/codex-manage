import type { Pool } from "pg";
import type { PaymentProvider } from "@codex-manage/payment-core";
import { BillingPgRepository } from "@codex-manage/payment-pg";
import { AlipayProvider } from "@codex-manage/payment-provider-alipay";
import { WechatPayProvider } from "@codex-manage/payment-provider-wechat";
import { PaymentService } from "@codex-manage/payment-service";
import type { ControlConfig } from "../config";
import { CodexBillingFulfillment } from "./CodexBillingFulfillment";
import { OfflinePaymentProvider } from "./OfflinePaymentProvider";

export function createPaymentService(config: ControlConfig, pool: Pool): PaymentService {
  const providers: PaymentProvider[] = [];
  if (isWechatConfigured(config)) {
    providers.push(new WechatPayProvider({
      appId: config.billing.wechat.appId,
      merchantId: config.billing.wechat.merchantId,
      apiV3Key: config.billing.wechat.apiV3Key,
      privateKeyPem: config.billing.wechat.privateKeyPem,
      certificateSerialNo: config.billing.wechat.certificateSerialNo,
      platformCertificatePem: config.billing.wechat.platformCertificatePem,
      notifyUrl: config.billing.wechat.notifyUrl,
      apiBaseUrl: config.billing.wechat.apiBaseUrl ?? undefined
    }));
  }
  if (isAlipayConfigured(config)) {
    providers.push(new AlipayProvider({
      appId: config.billing.alipay.appId,
      privateKeyPem: config.billing.alipay.privateKeyPem,
      publicKeyPem: config.billing.alipay.publicKeyPem,
      notifyUrl: config.billing.alipay.notifyUrl,
      gatewayUrl: config.billing.alipay.gatewayUrl ?? undefined
    }));
  }
  if (config.billing.offlinePayments.enabled && config.billing.offlinePayments.secret) {
    providers.push(new OfflinePaymentProvider("wechat", config.billing.offlinePayments.secret));
    providers.push(new OfflinePaymentProvider("alipay", config.billing.offlinePayments.secret));
  }
  return new PaymentService({
    repository: new BillingPgRepository(pool),
    providers,
    fulfillmentPort: new CodexBillingFulfillment(pool),
    orderExpiresInSeconds: config.billing.orderExpiresInSeconds
  });
}

function isWechatConfigured(config: ControlConfig): config is ControlConfig & {
  billing: { wechat: {
    appId: string;
    merchantId: string;
    apiV3Key: string;
    privateKeyPem: string;
    certificateSerialNo: string;
    platformCertificatePem: string;
    notifyUrl: string;
    apiBaseUrl: string | null;
  } };
} {
  return config.billing.wechat.enabled
    && Boolean(config.billing.wechat.appId)
    && Boolean(config.billing.wechat.merchantId)
    && Boolean(config.billing.wechat.apiV3Key)
    && Boolean(config.billing.wechat.privateKeyPem)
    && Boolean(config.billing.wechat.certificateSerialNo)
    && Boolean(config.billing.wechat.platformCertificatePem)
    && Boolean(config.billing.wechat.notifyUrl);
}

function isAlipayConfigured(config: ControlConfig): config is ControlConfig & {
  billing: { alipay: {
    appId: string;
    privateKeyPem: string;
    publicKeyPem: string;
    notifyUrl: string;
    gatewayUrl: string | null;
  } };
} {
  return config.billing.alipay.enabled
    && Boolean(config.billing.alipay.appId)
    && Boolean(config.billing.alipay.privateKeyPem)
    && Boolean(config.billing.alipay.publicKeyPem)
    && Boolean(config.billing.alipay.notifyUrl);
}
