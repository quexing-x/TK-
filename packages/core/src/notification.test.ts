import { describe, expect, it } from "vitest";
import {
  NotificationChannelSettingsSchema,
  NotificationCredentialInputSchema,
} from "./notification.js";

describe("notification schemas", () => {
  it("validates SMTP settings without accepting an empty recipient list", () => {
    expect(() =>
      NotificationChannelSettingsSchema.parse({
        kind: "email",
        enabled: true,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        secure: true,
        from: "sender@example.com",
        recipients: [],
      }),
    ).toThrow();
  });

  it("keeps notification secrets in the credential input", () => {
    expect(
      NotificationCredentialInputSchema.parse({
        kind: "feishu",
        webhookUrl:
          "https://open.feishu.cn/open-apis/bot/v2/hook/example-token",
        signingSecret: "secret",
      }),
    ).toMatchObject({ kind: "feishu", signingSecret: "secret" });
  });
});
