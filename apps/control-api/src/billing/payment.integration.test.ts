import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "../app";
import type { ControlConfig } from "../config";
import { hashToken } from "../security";
import { PgControlStore } from "../db/PgControlStore";
import { createPaymentService } from "./createPaymentService";

describe("billing payment integration", () => {
  it("creates an order, accepts a signed callback and grants Codex entitlements once", async () => {
    const database = new PGlite();
    const sql = await readFile(new URL("../db/migrations/001_initial.sql", import.meta.url), "utf8");
    await database.exec(sql);
    const pool = createPglitePool(database);
    const store = new PgControlStore(pool);
    const config = testConfig();
    const paymentService = createPaymentService(config, pool);
    const { app } = await createControlApp(config, store, { send: vi.fn(async () => undefined) }, null, paymentService);

    try {
      const user = await store.createUserWithIdentity({
        type: "email",
        identifier: "pay@example.com",
        passwordHash: "hash"
      });
      await store.createToken({
        subjectType: "user",
        subjectId: user.id,
        tokenType: "access",
        tokenHash: hashToken("cm_access_payment_test"),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await database.query(`
        UPDATE billing_plans
        SET price_cents = 19900, purchase_enabled = true
        WHERE code = 'formal_year'
      `);

      const created = await app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: { authorization: "Bearer cm_access_payment_test" },
        payload: { planCode: "formal_year", channel: "wechat", clientType: "desktop" }
      });
      expect(created.statusCode).toBe(200);
      const order = created.json().order as { id: string; order_no: string; amount_cents: number };
      expect(order.amount_cents).toBe(19900);

      const pay = await app.inject({
        method: "POST",
        url: `/v1/orders/${order.id}/pay`,
        headers: { authorization: "Bearer cm_access_payment_test" },
        payload: { channel: "wechat" }
      });
      expect(pay.statusCode).toBe(200);
      expect(pay.json().payment.qr_code_url).toContain("codex-manage://offline-pay");

      const callbackBody = JSON.stringify({
        orderNo: order.order_no,
        providerTransactionId: "offline-tx-1",
        amountCents: 19900,
        tradeState: "SUCCESS"
      });
      const signature = createHmac("sha256", "offline-secret").update(callbackBody).digest("hex");
      const callback = await app.inject({
        method: "POST",
        url: "/v1/payments/wechat/callback",
        headers: {
          "content-type": "application/json",
          "x-codex-offline-signature": signature
        },
        payload: callbackBody
      });
      expect(callback.statusCode).toBe(200);

      const duplicate = await app.inject({
        method: "POST",
        url: "/v1/payments/wechat/callback",
        headers: {
          "content-type": "application/json",
          "x-codex-offline-signature": signature
        },
        payload: callbackBody
      });
      expect(duplicate.statusCode).toBe(200);

      expect(await store.getEntitlements(user.id)).toMatchObject({
        "tunnel.quick": true,
        "tunnel.named": true,
        "device.max_count": 5
      });
      expect(await store.getCurrentSubscription(user.id)).toMatchObject({
        plan_code: "formal",
        plan_name: "正式版"
      });
      const subscriptions = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM subscriptions WHERE user_id = $1 AND source = 'payment'", [user.id]);
      expect(Number(subscriptions.rows[0].count)).toBe(1);
    } finally {
      await app.close();
      await database.close();
    }
  }, 20_000);
});

function testConfig(): ControlConfig {
  return {
    host: "127.0.0.1",
    port: 4320,
    databaseUrl: "postgres://test",
    adminOrigin: "https://codex-admin.xmwefun.cn",
    publicDomain: "xmwefun.cn",
    allowDebugCodes: true,
    emailWebhookUrl: null,
    smsWebhookUrl: null,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    deviceTokenTtlSeconds: 900,
    verificationCodeTtlSeconds: 600,
    billing: {
      orderExpiresInSeconds: 900,
      offlinePayments: { enabled: true, secret: "offline-secret" },
      wechat: {
        enabled: false,
        appId: null,
        merchantId: null,
        apiV3Key: null,
        privateKeyPem: null,
        certificateSerialNo: null,
        platformCertificatePem: null,
        notifyUrl: null,
        apiBaseUrl: null
      },
      alipay: {
        enabled: false,
        appId: null,
        privateKeyPem: null,
        publicKeyPem: null,
        notifyUrl: null,
        gatewayUrl: null
      }
    },
    cloudflare: { apiToken: null, accountId: null, zoneId: null }
  };
}

function createPglitePool(database: PGlite): Pool {
  const query = async (text: string, values?: unknown[]) => {
    const result = await database.query(text, values as never[] | undefined);
    return {
      ...result,
      rowCount: text.trimStart().toUpperCase().startsWith("SELECT")
        ? result.rows.length
        : (result.affectedRows ?? result.rows.length)
    };
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return {
    query,
    connect: async () => client,
    end: async () => undefined
  } as unknown as Pool;
}
