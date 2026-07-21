export type PaymentRequest = {
  orderId: string;
  orderNo: string;
  amountCents: number;
  currency: string;
  returnUrl: string;
};

export type PaymentParameters = {
  channel: string;
  payload: Record<string, string>;
  expiresAt: string;
};

/**
 * Reserved V1 boundary for a future WeChat Pay, Alipay, or other provider.
 * No implementation is registered while real payments remain disabled.
 */
export interface PaymentAdapter {
  createPayment(input: PaymentRequest): Promise<PaymentParameters>;
  verifyCallback(headers: Record<string, string | undefined>, body: string): Promise<{
    orderNo: string;
    channelTransactionId: string;
    paidAt: string;
  }>;
  refund(input: { orderId: string; amountCents: number; reason: string }): Promise<{ refundId: string }>;
}
