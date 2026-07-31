import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { connect as createTlsConnection } from "node:tls";
import type { ControlConfig } from "./config";
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

export type SmtpVerificationConfig = ControlConfig["smtp"];

export function createVerificationNotifier(config: ControlConfig): VerificationNotifier {
  const webhook = new WebhookVerificationNotifier(config.emailWebhookUrl, config.smsWebhookUrl, config.allowDebugCodes);
  const smtp = isSmtpConfigured(config.smtp) ? new SmtpEmailVerificationNotifier(config.smtp) : null;
  return new RoutedVerificationNotifier(webhook, smtp);
}

class RoutedVerificationNotifier implements VerificationNotifier {
  constructor(
    private readonly fallback: VerificationNotifier,
    private readonly smtp: SmtpEmailVerificationNotifier | null
  ) {}

  async send(notification: VerificationNotification): Promise<void> {
    if (notification.type === "email" && this.smtp) {
      await this.smtp.send(notification);
      return;
    }
    await this.fallback.send(notification);
  }
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

export class SmtpEmailVerificationNotifier implements VerificationNotifier {
  constructor(private readonly config: SmtpVerificationConfig) {}

  async send(notification: VerificationNotification): Promise<void> {
    if (notification.type !== "email") {
      throw new ControlError("NOTIFIER_UNAVAILABLE", "短信验证码发送服务尚未配置", 503);
    }
    if (!isSmtpConfigured(this.config)) {
      throw new ControlError("NOTIFIER_UNAVAILABLE", "SMTP 邮件验证码发送服务尚未配置", 503);
    }

    try {
      const client = await SmtpClient.connect(this.config);
      try {
        await client.sendMail({
          fromEmail: this.config.fromEmail,
          fromName: this.config.fromName,
          toEmail: notification.identifier,
          subject: verificationSubject(notification.purpose),
          text: verificationText(notification)
        });
      } finally {
        await client.quit().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError("NOTIFICATION_FAILED", "邮件验证码发送失败", 502);
    }
  }
}

type MailMessage = {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  text: string;
};

class SmtpClient {
  private buffer = "";
  private readonly pending: Array<(line: string) => void> = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(String(chunk)));
    socket.on("error", (error) => this.rejectPending(error));
    socket.on("close", () => this.rejectPending(new Error("SMTP 连接已关闭")));
  }

  static async connect(config: RequiredSmtpConfig): Promise<SmtpClient> {
    const socket = await openSocket(config);
    const client = new SmtpClient(socket);
    await client.expect(220);
    await client.command(`EHLO ${smtpClientName()}`, 250);
    await client.command("AUTH LOGIN", 334);
    await client.command(Buffer.from(config.user, "utf8").toString("base64"), 334);
    await client.command(Buffer.from(config.password, "utf8").toString("base64"), 235);
    return client;
  }

  async sendMail(message: MailMessage): Promise<void> {
    validateEmail(message.fromEmail, "发件邮箱格式不正确");
    validateEmail(message.toEmail, "收件邮箱格式不正确");
    await this.command(`MAIL FROM:<${message.fromEmail}>`, 250);
    await this.command(`RCPT TO:<${message.toEmail}>`, 250);
    await this.command("DATA", 354);
    await this.command(`${formatMessage(message)}\r\n.`, 250);
  }

  async quit(): Promise<void> {
    if (this.socket.destroyed) return;
    await this.command("QUIT", 221);
    this.socket.end();
  }

  private async command(command: string, expectedCode: number): Promise<string> {
    this.socket.write(`${command}\r\n`);
    return await this.expect(expectedCode);
  }

  private expect(expectedCode: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`SMTP 响应超时：${expectedCode}`));
      }, 15_000);
      const cleanup = () => clearTimeout(timer);
      this.pending.push((line) => {
        cleanup();
        const code = Number.parseInt(line.slice(0, 3), 10);
        if (code !== expectedCode) {
          reject(new Error(`SMTP 响应异常：${line}`));
          return;
        }
        resolve(line);
      });
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line || !/^\d{3} /.test(line)) continue;
      const next = this.pending.shift();
      next?.(line);
    }
  }

  private rejectPending(error: Error): void {
    while (this.pending.length) {
      const next = this.pending.shift();
      next?.(`599 ${error.message}`);
    }
  }
}

type RequiredSmtpConfig = SmtpVerificationConfig & {
  host: string;
  user: string;
  password: string;
  fromEmail: string;
};

function isSmtpConfigured(config: SmtpVerificationConfig): config is RequiredSmtpConfig {
  return Boolean(config.host && config.user && config.password && config.fromEmail);
}

async function openSocket(config: RequiredSmtpConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? createTlsConnection({ host: config.host, port: config.port, servername: config.host })
      : createConnection({ host: config.host, port: config.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP 连接超时"));
    }, 15_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function verificationSubject(purpose: string): string {
  return purpose === "password_reset" ? "Codex Manage 密码重置验证码" : "Codex Manage 邮箱验证码";
}

function verificationText(notification: VerificationNotification): string {
  const expiresAt = new Date(notification.expiresAt).toLocaleString("zh-CN", { hour12: false });
  return [
    `您的 Codex Manage 验证码是：${notification.code}`,
    "",
    `用途：${purposeLabel(notification.purpose)}`,
    `有效期至：${expiresAt}`,
    "",
    "如果不是您本人操作，请忽略此邮件。"
  ].join("\n");
}

function purposeLabel(purpose: string): string {
  if (purpose === "password_reset") return "重置密码";
  if (purpose === "bind_identity") return "绑定身份";
  return "注册/登录验证";
}

function formatMessage(message: MailMessage): string {
  return [
    `From: ${formatAddress(message.fromName, message.fromEmail)}`,
    `To: <${message.toEmail}>`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${message.fromEmail.split("@")[1]}>`,
    "",
    dotStuff(message.text)
  ].join("\r\n");
}

function formatAddress(name: string, email: string): string {
  return `${encodeHeader(sanitizeHeader(name))} <${email}>`;
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(sanitizeHeader(value), "utf8").toString("base64")}?=`;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function dotStuff(value: string): string {
  return value.replace(/\r?\n/g, "\r\n").split("\r\n").map((line) => line.startsWith(".") ? `.${line}` : line).join("\r\n");
}

function validateEmail(value: string, message: string): void {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) {
    throw new ControlError("INVALID_EMAIL", message, 400);
  }
}

function smtpClientName(): string {
  return "codex-manage.local";
}
