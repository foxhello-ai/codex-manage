import { createDecipheriv, randomBytes, sign, verify } from "node:crypto";
import {
  BillingError,
  type CreatePaymentInput,
  type PaymentProvider,
  type PaymentProviderResult,
  type VerifiedPaymentCallback
} from "@codex-manage/payment-core";

export type WechatPayConfig = {
  appId: string;
  merchantId: string;
  apiV3Key: string;
  privateKeyPem: string;
  certificateSerialNo: string;
  platformCertificatePem: string;
  notifyUrl: string;
  apiBaseUrl?: string;
};

export class WechatPayProvider implements PaymentProvider {
  readonly provider = "wechat" as const;
  private readonly apiBaseUrl: string;

  constructor(private readonly config: WechatPayConfig) {
    this.apiBaseUrl = config.apiBaseUrl ?? "https://api.mch.weixin.qq.com";
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentProviderResult> {
    const path = "/v3/pay/transactions/native";
    const body = JSON.stringify({
      appid: this.config.appId,
      mchid: this.config.merchantId,
      description: input.order.planName,
      out_trade_no: input.order.orderNo,
      time_expire: input.order.expiresAt,
      notify_url: this.config.notifyUrl,
      amount: {
        total: input.order.amountCents,
        currency: input.order.currency
      }
    });
    const response = await fetch(new URL(path, this.apiBaseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: this.authorization("POST", path, body)
      },
      body
    });
    const payload = await response.json().catch(() => null) as { code_url?: string; message?: string; code?: string } | null;
    if (!response.ok || !payload?.code_url) {
      throw new BillingError("PAYMENT_PROVIDER_ERROR", payload?.message ?? "微信支付下单失败", 502, payload);
    }
    return {
      provider: this.provider,
      channel: "native_qr",
      providerOrderNo: input.order.orderNo,
      qrCodeUrl: payload.code_url,
      expiresAt: input.order.expiresAt,
      payload: {}
    };
  }

  async verifyCallback(input: { headers: Record<string, string | string[] | undefined>; rawBody: string }): Promise<VerifiedPaymentCallback> {
    const timestamp = headerValue(input.headers, "wechatpay-timestamp");
    const nonce = headerValue(input.headers, "wechatpay-nonce");
    const signature = headerValue(input.headers, "wechatpay-signature");
    if (!timestamp || !nonce || !signature) {
      throw new BillingError("PAYMENT_SIGNATURE_INVALID", "微信支付回调签名缺失", 400);
    }
    const message = `${timestamp}\n${nonce}\n${input.rawBody}\n`;
    const valid = verify("RSA-SHA256", Buffer.from(message), this.config.platformCertificatePem, Buffer.from(signature, "base64"));
    if (!valid) throw new BillingError("PAYMENT_SIGNATURE_INVALID", "微信支付回调验签失败", 400);

    const body = JSON.parse(input.rawBody) as {
      resource?: { ciphertext?: string; nonce?: string; associated_data?: string };
    };
    const resource = body.resource;
    if (!resource?.ciphertext || !resource.nonce) {
      throw new BillingError("PAYMENT_SIGNATURE_INVALID", "微信支付回调内容无效", 400);
    }
    const transaction = JSON.parse(decryptWechatResource(this.config.apiV3Key, {
      ciphertext: resource.ciphertext,
      nonce: resource.nonce,
      associated_data: resource.associated_data
    })) as {
      out_trade_no: string;
      transaction_id: string;
      trade_state: string;
      success_time?: string;
      amount?: { total?: number; currency?: string };
    };
    return {
      provider: this.provider,
      orderNo: transaction.out_trade_no,
      providerTransactionId: transaction.transaction_id,
      amountCents: Number(transaction.amount?.total ?? 0),
      currency: "CNY",
      paidAt: transaction.success_time ? new Date(transaction.success_time).toISOString() : new Date().toISOString(),
      tradeState: transaction.trade_state === "SUCCESS" ? "SUCCESS" : transaction.trade_state === "CLOSED" ? "CLOSED" : "FAILED",
      rawPayloadRedacted: {
        out_trade_no: transaction.out_trade_no,
        transaction_id: redact(transaction.transaction_id),
        trade_state: transaction.trade_state,
        amount: transaction.amount
      }
    };
  }

  private authorization(method: string, path: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = sign("RSA-SHA256", Buffer.from(message), this.config.privateKeyPem).toString("base64");
    return [
      "WECHATPAY2-SHA256-RSA2048",
      `mchid="${this.config.merchantId}"`,
      `nonce_str="${nonce}"`,
      `signature="${signature}"`,
      `timestamp="${timestamp}"`,
      `serial_no="${this.config.certificateSerialNo}"`
    ].join(",");
  }
}

function decryptWechatResource(apiV3Key: string, resource: { ciphertext: string; nonce: string; associated_data?: string }): string {
  const encrypted = Buffer.from(resource.ciphertext, "base64");
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const authTag = encrypted.subarray(encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(resource.nonce));
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function redact(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}
