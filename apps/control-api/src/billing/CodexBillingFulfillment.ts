import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BillingFulfillment, PaidOrderFulfillmentInput, PaymentFulfillmentContext, PaymentFulfillmentPort } from "@codex-manage/payment-core";

export class CodexBillingFulfillment implements PaymentFulfillmentPort {
  constructor(private readonly pool: Pool) {}

  async fulfillPaidOrder(input: PaidOrderFulfillmentInput, context?: PaymentFulfillmentContext): Promise<BillingFulfillment> {
    const existingClient = context?.transaction as PoolClient | undefined;
    if (existingClient) return await this.fulfillWithClient(existingClient, input);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.fulfillWithClient(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async fulfillWithClient(client: PoolClient, input: PaidOrderFulfillmentInput): Promise<BillingFulfillment> {
    const existing = await client.query(`
      SELECT s.id, s.expires_at
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.status = 'active' AND p.code = 'formal'
        AND s.starts_at <= now() AND (s.expires_at IS NULL OR s.expires_at > now())
      ORDER BY s.expires_at DESC NULLS FIRST, s.starts_at DESC
      LIMIT 1
      FOR UPDATE OF s
    `, [input.userId]);
    const current = existing.rows[0] as { id: string; expires_at: Date | string | null } | undefined;
    if (current?.expires_at === null) {
      await insertAudit(client, "subscription.payment_keep_lifetime", input.userId, {
        orderNo: input.orderNo,
        planCode: input.plan.code,
        provider: input.provider
      });
      return {
        fulfilled: true,
        businessObjectType: "subscription",
        businessObjectId: current.id,
        startsAt: input.paidAt,
        expiresAt: null,
        summary: {
          mode: "kept_lifetime",
          orderNo: input.orderNo,
          planCode: input.plan.code,
          expiresAt: null
        }
      };
    }

    const paidAt = new Date(input.paidAt);
    const baseTime = current?.expires_at && new Date(current.expires_at).getTime() > paidAt.getTime()
      ? new Date(current.expires_at)
      : paidAt;
    const expiresAt = input.plan.durationDays
      ? new Date(baseTime.getTime() + input.plan.durationDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const startsAt = baseTime.toISOString();
    const subscriptionId = randomUUID();
    await client.query(`
      INSERT INTO subscriptions (id, user_id, plan_id, source, status, starts_at, expires_at)
      VALUES ($1,$2,'plan-formal','payment','active',$3,$4)
    `, [subscriptionId, input.userId, startsAt, expiresAt]);
    await insertEntitlement(client, input.userId, subscriptionId, "tunnel.quick", entitlementValue(input, "tunnel.quick", true), startsAt, expiresAt);
    await insertEntitlement(client, input.userId, subscriptionId, "tunnel.named", entitlementValue(input, "tunnel.named", true), startsAt, expiresAt);
    await insertEntitlement(client, input.userId, subscriptionId, "device.max_count", entitlementValue(input, "device.max_count", 5), startsAt, expiresAt);
    await insertAudit(client, "subscription.payment_grant", input.userId, {
      orderNo: input.orderNo,
      planCode: input.plan.code,
      provider: input.provider,
      providerTransactionId: input.providerTransactionId,
      startsAt,
      expiresAt
    });
    return {
      fulfilled: true,
      businessObjectType: "subscription",
      businessObjectId: subscriptionId,
      startsAt,
      expiresAt,
      summary: {
        mode: current ? "extended" : "upgraded",
        orderNo: input.orderNo,
        planCode: input.plan.code,
        startsAt,
        expiresAt
      }
    };
  }
}

async function insertEntitlement(
  client: PoolClient,
  userId: string,
  subscriptionId: string,
  key: string,
  value: unknown,
  startsAt: string,
  expiresAt: string | null
): Promise<void> {
  await client.query(`
    INSERT INTO entitlements (
      id, user_id, subscription_id, entitlement_key, entitlement_value, starts_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
  `, [randomUUID(), userId, subscriptionId, key, JSON.stringify(value), startsAt, expiresAt]);
}

async function insertAudit(client: PoolClient, action: string, userId: string, summary: Record<string, unknown>): Promise<void> {
  await client.query(`
    INSERT INTO audit_logs (id, admin_user_id, action, target_type, target_id, summary)
    VALUES ($1,NULL,$2,'user',$3,$4::jsonb)
  `, [randomUUID(), action, userId, JSON.stringify(summary)]);
}

function entitlementValue(input: PaidOrderFulfillmentInput, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(input.plan.features, key) ? input.plan.features[key] : fallback;
}
