import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  BillingError,
  toPlanSnapshot,
  type BillingOrder,
  type BillingOrderDetail,
  type BillingOrderStatus,
  type BillingPayment,
  type BillingPlan,
  type BillingRepository,
  type CreateBillingOrderInput,
  type PaymentFulfillmentPort,
  type PaymentProviderResult,
  type VerifiedPaymentCallback
} from "@codex-manage/payment-core";

export class BillingPgRepository implements BillingRepository {
  constructor(private readonly pool: Pool) {}

  async listPlans(): Promise<BillingPlan[]> {
    const result = await this.pool.query(`
      SELECT * FROM billing_plans
      WHERE status = 'active'
      ORDER BY sort_order ASC, price_cents ASC, created_at ASC
    `);
    return result.rows.map(mapPlan);
  }

  async listAdminPlans(): Promise<BillingPlan[]> {
    const result = await this.pool.query("SELECT * FROM billing_plans ORDER BY sort_order ASC, created_at ASC");
    return result.rows.map(mapPlan);
  }

  async updateAdminPlan(planId: string, input: Parameters<BillingRepository["updateAdminPlan"]>[1]): Promise<BillingPlan | null> {
    return this.transaction(async (client) => {
      const current = await client.query("SELECT * FROM billing_plans WHERE id = $1 FOR UPDATE", [planId]);
      if (!current.rows[0]) return null;
      const row = current.rows[0];
      const next = {
        name: input.name ?? row.name,
        description: input.description === undefined ? row.description : input.description,
        priceCents: input.priceCents ?? Number(row.price_cents),
        billingPeriod: input.billingPeriod ?? row.billing_period,
        durationDays: input.durationDays === undefined ? row.duration_days : input.durationDays,
        purchaseEnabled: input.purchaseEnabled ?? Boolean(row.purchase_enabled),
        features: input.features ?? row.features ?? {},
        status: input.status ?? row.status,
        sortOrder: input.sortOrder ?? Number(row.sort_order)
      };
      const updated = await client.query(`
        UPDATE billing_plans
        SET name = $2, description = $3, price_cents = $4, billing_period = $5,
          duration_days = $6, purchase_enabled = $7, features = $8::jsonb,
          status = $9, sort_order = $10, updated_at = now()
        WHERE id = $1
        RETURNING *
      `, [
        planId,
        next.name,
        next.description,
        next.priceCents,
        next.billingPeriod,
        next.durationDays,
        next.purchaseEnabled,
        JSON.stringify(next.features),
        next.status,
        next.sortOrder
      ]);
      return mapPlan(updated.rows[0]);
    });
  }

  async createOrReuseOrder(input: CreateBillingOrderInput, orderExpiresInSeconds: number): Promise<BillingOrder> {
    return this.transaction(async (client) => {
      const plan = await this.getPurchasablePlan(client, input);
      if (!plan) throw new BillingError("PLAN_NOT_PURCHASABLE", "套餐不可购买", 400);
      const existing = await client.query(`
        SELECT * FROM billing_orders
        WHERE user_id = $1 AND plan_id = $2 AND channel = $3
          AND status IN ('pending','paying') AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [input.userId, plan.id, input.channel]);
      if (existing.rows[0]) return mapOrder(existing.rows[0]);

      const now = new Date();
      const expiresAt = new Date(now.getTime() + orderExpiresInSeconds * 1000).toISOString();
      const planSnapshot = toPlanSnapshot(plan);
      const created = await client.query(`
        INSERT INTO billing_orders (
          id, order_no, user_id, plan_id, plan_code, plan_name, plan_snapshot,
          amount_cents, currency, channel, client_type, status, expires_at, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'pending',$12,$13::jsonb)
        RETURNING *
      `, [
        randomUUID(),
        createOrderNo(),
        input.userId,
        plan.id,
        plan.code,
        plan.name,
        JSON.stringify(planSnapshot),
        plan.priceCents,
        plan.currency,
        input.channel,
        input.clientType,
        expiresAt,
        JSON.stringify({ returnUrl: input.returnUrl ?? null })
      ]);
      return mapOrder(created.rows[0]);
    });
  }

  async listUserOrders(userId: string, input: { status?: BillingOrderStatus; limit?: number; cursor?: string | null } = {}): Promise<{ orders: BillingOrder[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const params: unknown[] = [userId, limit + 1];
    const filters = ["user_id = $1"];
    if (input.status) {
      params.push(input.status);
      filters.push(`status = $${params.length}`);
    }
    if (input.cursor) {
      params.push(input.cursor);
      filters.push(`created_at < $${params.length}`);
    }
    const result = await this.pool.query(`
      SELECT * FROM billing_orders
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $2
    `, params);
    const rows = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? new Date(result.rows[limit].created_at).toISOString() : null;
    return { orders: rows.map(mapOrder), nextCursor: next };
  }

  async getUserOrderDetail(userId: string, orderId: string): Promise<BillingOrderDetail | null> {
    const order = await this.pool.query("SELECT * FROM billing_orders WHERE id = $1 AND user_id = $2", [orderId, userId]);
    if (!order.rows[0]) return null;
    return await this.detailForOrder(this.pool, mapOrder(order.rows[0]));
  }

  async getPayableOrder(userId: string, orderId: string): Promise<BillingOrder> {
    return this.transaction(async (client) => {
      const result = await client.query("SELECT * FROM billing_orders WHERE id = $1 AND user_id = $2 FOR UPDATE", [orderId, userId]);
      const row = result.rows[0];
      if (!row) throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
      const order = mapOrder(row);
      if (order.status === "paid") throw new BillingError("ORDER_ALREADY_PAID", "订单已支付", 409);
      if (!["pending", "paying"].includes(order.status)) throw new BillingError("ORDER_NOT_PAYABLE", "当前订单状态不可支付", 409, { status: order.status });
      if (new Date(order.expiresAt).getTime() <= Date.now()) {
        await client.query("UPDATE billing_orders SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [order.id]);
        throw new BillingError("ORDER_EXPIRED", "订单已过期", 409);
      }
      return order;
    });
  }

  async savePaymentParameters(order: BillingOrder, result: PaymentProviderResult): Promise<BillingOrderDetail> {
    return this.transaction(async (client) => {
      const current = await client.query("SELECT * FROM billing_orders WHERE id = $1 FOR UPDATE", [order.id]);
      if (!current.rows[0]) throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
      const lockedOrder = mapOrder(current.rows[0]);
      if (lockedOrder.status === "paid") throw new BillingError("ORDER_ALREADY_PAID", "订单已支付", 409);
      if (!["pending", "paying"].includes(lockedOrder.status)) throw new BillingError("ORDER_NOT_PAYABLE", "当前订单状态不可支付", 409, { status: lockedOrder.status });
      await client.query("UPDATE billing_orders SET status = 'paying', updated_at = now() WHERE id = $1", [lockedOrder.id]);
      const existing = await client.query(`
        SELECT * FROM billing_payments
        WHERE order_id = $1 AND provider = $2 AND status = 'pending' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1
      `, [lockedOrder.id, result.provider]);
      if (existing.rows[0]) return await this.detailForOrder(client, { ...lockedOrder, status: "paying" });
      await client.query(`
        INSERT INTO billing_payments (
          id, order_id, provider, channel, provider_order_no, amount_cents, currency,
          status, qr_code_url, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
      `, [
        randomUUID(),
        lockedOrder.id,
        result.provider,
        result.channel,
        result.providerOrderNo,
        lockedOrder.amountCents,
        lockedOrder.currency,
        result.qrCodeUrl,
        result.expiresAt
      ]);
      const updated = await client.query("SELECT * FROM billing_orders WHERE id = $1", [lockedOrder.id]);
      return await this.detailForOrder(client, mapOrder(updated.rows[0]));
    });
  }

  async closeUserOrder(userId: string, orderId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await client.query("SELECT * FROM billing_orders WHERE id = $1 AND user_id = $2 FOR UPDATE", [orderId, userId]);
      if (!current.rows[0]) return false;
      const order = mapOrder(current.rows[0]);
      if (order.status === "paid") throw new BillingError("ORDER_ALREADY_PAID", "订单已支付", 409);
      if (!["pending", "paying"].includes(order.status)) return true;
      await client.query(`
        UPDATE billing_orders SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE id = $1
      `, [order.id]);
      await client.query(`
        UPDATE billing_payments SET status = 'closed', updated_at = now()
        WHERE order_id = $1 AND status IN ('created','pending')
      `, [order.id]);
      return true;
    });
  }

  async completeVerifiedPayment(input: VerifiedPaymentCallback, fulfillmentPort: PaymentFulfillmentPort): Promise<BillingOrderDetail & { duplicated: boolean }> {
    return this.transaction(async (client) => {
      const callbackLogId = randomUUID();
      await client.query(`
        INSERT INTO billing_payment_callback_logs (
          id, provider, order_no, provider_transaction_id, signature_valid, processing_status, raw_payload_redacted
        ) VALUES ($1,$2,$3,$4,true,'processing',$5::jsonb)
      `, [callbackLogId, input.provider, input.orderNo, input.providerTransactionId, JSON.stringify(input.rawPayloadRedacted)]);

      const orderResult = await client.query("SELECT * FROM billing_orders WHERE order_no = $1 FOR UPDATE", [input.orderNo]);
      const orderRow = orderResult.rows[0];
      if (!orderRow) {
        await this.markCallbackFailed(client, callbackLogId, "ORDER_NOT_FOUND");
        throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
      }
      const order = mapOrder(orderRow);
      if (order.amountCents !== input.amountCents || order.currency !== input.currency) {
        await this.markCallbackFailed(client, callbackLogId, "PAYMENT_AMOUNT_MISMATCH");
        throw new BillingError("PAYMENT_AMOUNT_MISMATCH", "支付金额不一致", 409, {
          expected: { amountCents: order.amountCents, currency: order.currency },
          actual: { amountCents: input.amountCents, currency: input.currency }
        });
      }

      const duplicatedPayment = await client.query(`
        SELECT * FROM billing_payments
        WHERE provider = $1 AND provider_transaction_id = $2 AND status = 'succeeded'
        LIMIT 1
      `, [input.provider, input.providerTransactionId]);
      if (duplicatedPayment.rows[0] && order.status === "paid") {
        await this.markCallbackProcessed(client, callbackLogId, duplicatedPayment.rows[0].id);
        const detail = await this.detailForOrder(client, order);
        return { ...detail, duplicated: true };
      }

      const paymentResult = await client.query(`
        UPDATE billing_payments
        SET status = $3, provider_transaction_id = $4, paid_at = $5, callback_received_at = now(), updated_at = now()
        WHERE order_id = $1 AND provider = $2
        RETURNING *
      `, [
        order.id,
        input.provider,
        input.tradeState === "SUCCESS" ? "succeeded" : input.tradeState === "CLOSED" ? "closed" : "failed",
        input.providerTransactionId,
        input.tradeState === "SUCCESS" ? input.paidAt : null
      ]);
      const paymentRow = paymentResult.rows[0] ?? (await client.query(`
        INSERT INTO billing_payments (
          id, order_id, provider, channel, provider_transaction_id, amount_cents, currency,
          status, paid_at, callback_received_at, expires_at
        ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,now(),$9)
        RETURNING *
      `, [
        randomUUID(),
        order.id,
        input.provider,
        input.providerTransactionId,
        input.amountCents,
        input.currency,
        input.tradeState === "SUCCESS" ? "succeeded" : input.tradeState === "CLOSED" ? "closed" : "failed",
        input.tradeState === "SUCCESS" ? input.paidAt : null,
        order.expiresAt
      ])).rows[0];

      if (input.tradeState !== "SUCCESS") {
        await client.query("UPDATE billing_orders SET status = $2, updated_at = now() WHERE id = $1", [order.id, input.tradeState === "CLOSED" ? "closed" : "failed"]);
        await this.markCallbackProcessed(client, callbackLogId, paymentRow.id);
        const detail = await this.detailForOrder(client, order);
        return { ...detail, duplicated: false };
      }

      const existingFulfillment = await client.query(`
        SELECT * FROM billing_fulfillment_events WHERE fulfillment_id = $1 AND status = 'succeeded'
      `, [order.id]);
      if (existingFulfillment.rows[0]) {
        await client.query("UPDATE billing_orders SET status = 'paid', paid_at = COALESCE(paid_at, $2), updated_at = now() WHERE id = $1", [order.id, input.paidAt]);
        await this.markCallbackProcessed(client, callbackLogId, paymentRow.id);
        const detail = await this.detailForOrder(client, order);
        return { ...detail, duplicated: true };
      }

      await client.query("UPDATE billing_orders SET status = 'paid', paid_at = $2, updated_at = now() WHERE id = $1", [order.id, input.paidAt]);
      const fulfillment = await fulfillmentPort.fulfillPaidOrder({
        fulfillmentId: order.id,
        userId: order.userId,
        orderId: order.id,
        orderNo: order.orderNo,
        plan: order.planSnapshot,
        paidAt: input.paidAt,
        amountCents: order.amountCents,
        currency: order.currency,
        provider: input.provider,
        providerTransactionId: input.providerTransactionId
      }, { transaction: client });
      await client.query(`
        INSERT INTO billing_fulfillment_events (
          id, fulfillment_id, order_id, user_id, status, business_object_type, business_object_id, summary
        ) VALUES ($1,$2,$3,$4,'succeeded',$5,$6,$7::jsonb)
        ON CONFLICT (fulfillment_id) DO NOTHING
      `, [
        randomUUID(),
        order.id,
        order.id,
        order.userId,
        fulfillment.businessObjectType,
        fulfillment.businessObjectId,
        JSON.stringify(fulfillment.summary)
      ]);
      await this.markCallbackProcessed(client, callbackLogId, paymentRow.id);
      const detail = await this.detailForOrder(client, order);
      return { ...detail, fulfillment, duplicated: false };
    });
  }

  async recordInvalidCallback(input: { provider: "wechat" | "alipay"; rawPayloadRedacted: Record<string, unknown>; errorCode: string }): Promise<void> {
    await this.pool.query(`
      INSERT INTO billing_payment_callback_logs (
        id, provider, signature_valid, processing_status, error_code, raw_payload_redacted
      ) VALUES ($1,$2,false,'failed',$3,$4::jsonb)
    `, [randomUUID(), input.provider, input.errorCode, JSON.stringify(input.rawPayloadRedacted)]);
  }

  async listAdminOrders(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT o.*, p.name AS plan_display_name
      FROM billing_orders o LEFT JOIN billing_plans p ON p.id = o.plan_id
      ORDER BY o.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminPayments(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT p.*, o.order_no, o.user_id, o.plan_code, o.plan_name
      FROM billing_payments p JOIN billing_orders o ON o.id = p.order_id
      ORDER BY p.created_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async listAdminCallbackLogs(): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT * FROM billing_payment_callback_logs
      ORDER BY received_at DESC LIMIT 500
    `);
    return result.rows;
  }

  async recordRefundRequest(input: { adminId: string; orderId: string; amountCents: number | null; reason: string }): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const order = await client.query("SELECT * FROM billing_orders WHERE id = $1", [input.orderId]);
      if (!order.rows[0]) throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
      const payment = await client.query(`
        SELECT * FROM billing_payments WHERE order_id = $1 AND status = 'succeeded'
        ORDER BY paid_at DESC LIMIT 1
      `, [input.orderId]);
      const created = await client.query(`
        INSERT INTO billing_refund_requests (
          id, order_id, payment_id, requested_by_admin_id, amount_cents, reason, status
        ) VALUES ($1,$2,$3,$4,$5,$6,'requested')
        RETURNING *
      `, [
        randomUUID(),
        input.orderId,
        payment.rows[0]?.id ?? null,
        input.adminId,
        input.amountCents ?? Number(order.rows[0].amount_cents),
        input.reason
      ]);
      return created.rows[0];
    });
  }

  private async getPurchasablePlan(client: PoolClient, input: CreateBillingOrderInput): Promise<BillingPlan | null> {
    const params = input.planId ? [input.planId] : [input.planCode ?? ""];
    const condition = input.planId ? "id = $1" : "code = $1";
    const result = await client.query(`
      SELECT * FROM billing_plans
      WHERE ${condition} AND status = 'active' AND purchase_enabled = true
      LIMIT 1
    `, params);
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  private async detailForOrder(queryable: Pick<Pool | PoolClient, "query">, order: BillingOrder): Promise<BillingOrderDetail> {
    const payment = await queryable.query(`
      SELECT * FROM billing_payments WHERE order_id = $1
      ORDER BY created_at DESC LIMIT 1
    `, [order.id]);
    const fulfillment = await queryable.query(`
      SELECT * FROM billing_fulfillment_events
      WHERE fulfillment_id = $1 AND status = 'succeeded'
      ORDER BY created_at DESC LIMIT 1
    `, [order.id]);
    return {
      order,
      payment: payment.rows[0] ? mapPayment(payment.rows[0]) : null,
      fulfillment: fulfillment.rows[0] ? {
        fulfilled: true,
        businessObjectType: fulfillment.rows[0].business_object_type,
        businessObjectId: fulfillment.rows[0].business_object_id,
        startsAt: new Date(fulfillment.rows[0].created_at).toISOString(),
        expiresAt: readJsonRecord(fulfillment.rows[0].summary).expiresAt as string | null ?? null,
        summary: readJsonRecord(fulfillment.rows[0].summary)
      } : null
    };
  }

  private async markCallbackProcessed(client: PoolClient, callbackLogId: string, paymentId: string): Promise<void> {
    await client.query(`
      UPDATE billing_payment_callback_logs
      SET payment_id = $2, processing_status = 'processed'
      WHERE id = $1
    `, [callbackLogId, paymentId]);
  }

  private async markCallbackFailed(client: PoolClient, callbackLogId: string, errorCode: string): Promise<void> {
    await client.query(`
      UPDATE billing_payment_callback_logs
      SET processing_status = 'failed', error_code = $2
      WHERE id = $1
    `, [callbackLogId, errorCode]);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function createOrderNo(): string {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `CM${timestamp}${randomBytes(4).toString("hex").toUpperCase()}`;
}

function mapPlan(row: Record<string, unknown>): BillingPlan {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    priceCents: Number(row.price_cents),
    currency: "CNY",
    billingPeriod: String(row.billing_period) as BillingPlan["billingPeriod"],
    durationDays: row.duration_days === null || row.duration_days === undefined ? null : Number(row.duration_days),
    purchaseEnabled: Boolean(row.purchase_enabled),
    features: readJsonRecord(row.features),
    status: String(row.status) as BillingPlan["status"],
    sortOrder: Number(row.sort_order ?? 0)
  };
}

function mapOrder(row: Record<string, unknown>): BillingOrder {
  const snapshot = readJsonRecord(row.plan_snapshot) as BillingOrder["planSnapshot"];
  return {
    id: String(row.id),
    orderNo: String(row.order_no),
    userId: String(row.user_id),
    planId: String(row.plan_id),
    planCode: String(row.plan_code),
    planName: String(row.plan_name),
    planSnapshot: snapshot,
    amountCents: Number(row.amount_cents),
    currency: "CNY",
    channel: String(row.channel) as BillingOrder["channel"],
    clientType: String(row.client_type),
    status: String(row.status) as BillingOrderStatus,
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at as string | Date).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at as string | Date).toISOString() : null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function mapPayment(row: Record<string, unknown>): BillingPayment {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    provider: String(row.provider) as BillingPayment["provider"],
    channel: String(row.channel),
    providerOrderNo: row.provider_order_no ? String(row.provider_order_no) : null,
    providerTransactionId: row.provider_transaction_id ? String(row.provider_transaction_id) : null,
    amountCents: Number(row.amount_cents),
    currency: "CNY",
    status: String(row.status) as BillingPayment["status"],
    qrCodeUrl: row.qr_code_url ? String(row.qr_code_url) : null,
    expiresAt: new Date(row.expires_at as string | Date).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at as string | Date).toISOString() : null,
    failureCode: row.failure_code ? String(row.failure_code) : null,
    failureMessage: row.failure_message ? String(row.failure_message) : null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString()
  };
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}
