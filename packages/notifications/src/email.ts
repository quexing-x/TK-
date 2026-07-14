import nodemailer, { type Transporter } from "nodemailer";
import type {
  NotificationChannelSettings,
  NotificationCredentialInput,
  NotificationRenderedMessage,
} from "@tk-auto/core";
import type { NotificationSendResult, NotificationSender } from "./types.js";

export type MailerFactory = (options: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}) => Pick<Transporter, "verify" | "sendMail">;

export class EmailNotificationSender implements NotificationSender {
  readonly kind = "email" as const;

  constructor(
    private readonly createMailer: MailerFactory = (options) =>
      nodemailer.createTransport(options),
  ) {}

  async send(
    settings: NotificationChannelSettings,
    credential: NotificationCredentialInput,
    message: NotificationRenderedMessage,
  ): Promise<NotificationSendResult> {
    if (settings.kind !== this.kind || credential.kind !== this.kind) {
      throw new Error("邮件通知配置类型不一致。");
    }
    const transporter = this.createMailer({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.secure,
      auth: { user: credential.username, pass: credential.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await transporter.verify();
    await transporter.sendMail({
      from: settings.from,
      to: settings.recipients,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { ok: true, message: "邮件测试消息发送成功。" };
  }
}
