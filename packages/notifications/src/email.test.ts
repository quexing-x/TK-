import { describe, expect, it, vi } from "vitest";
import { EmailNotificationSender, type MailerFactory } from "./email.js";
import { renderTestMessage } from "./format.js";

describe("email notification sender", () => {
  it("verifies SMTP before sending the rendered message", async () => {
    const verify = vi.fn(async () => true);
    const sendMail = vi.fn(async () => ({ messageId: "test-message" }));
    const factory: MailerFactory = vi.fn(
      () => ({ verify, sendMail }) as unknown as ReturnType<MailerFactory>,
    );
    const sender = new EmailNotificationSender(factory);

    await sender.send(
      {
        kind: "email",
        enabled: true,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        secure: true,
        from: "sender@example.com",
        recipients: ["owner@example.com"],
      },
      { kind: "email", username: "sender@example.com", password: "secret" },
      renderTestMessage(),
    );

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        auth: { user: "sender@example.com", pass: "secret" },
      }),
    );
    expect(verify).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.com",
        to: ["owner@example.com"],
        subject: "TK Ads 消息推送测试",
      }),
    );
  });
});
