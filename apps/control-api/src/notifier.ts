import type { IdentityType } from "./domain";
import { ControlError } from "./domain";

export type VerificationNotification = {
  type: IdentityType;
  identifier: string;
  code: string;
  purpose: string;
  expiresAt: string;
};

export interface VerificationNotifier {
  send(notification: VerificationNotification): Promise<void>;
}

export class WebhookVerificationNotifier implements VerificationNotifier {
  constructor(
    private readonly emailWebhookUrl: string | null,
    private readonly smsWebhookUrl: string | null,
    private readonly allowDebugCodes: boolean
  ) {}

  async send(notification: VerificationNotification): Promise<void> {
    const url = notification.type === "email" ? this.emailWebhookUrl : this.smsWebhookUrl;
    if (!url) {
      if (this.allowDebugCodes) {
        console.info(`[verification:${notification.type}] ${notification.identifier} code=${notification.code}`);
        return;
      }
      throw new ControlError("NOTIFIER_UNAVAILABLE", "验证码发送服务尚未配置", 503);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notification)
    });
    if (!response.ok) {
      throw new ControlError("NOTIFICATION_FAILED", "验证码发送失败", 502, { status: response.status });
    }
  }
}
