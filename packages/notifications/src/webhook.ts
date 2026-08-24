import { createHmac } from "node:crypto";
import type {
  NotificationChannelSettings,
  NotificationCredentialInput,
  NotificationRenderedMessage,
} from "@tk-auto/core";
import type { NotificationSendResult, NotificationSender } from "./types.js";

export class WecomNotificationSender implements NotificationSender {
  readonly kind = "wecom" as const;

  async send(
    settings: NotificationChannelSettings,
    credential: NotificationCredentialInput,
    message: NotificationRenderedMessage,
  ): Promise<NotificationSendResult> {
    if (settings.kind !== this.kind || credential.kind !== this.kind) {
      throw new Error("企业微信通知配置类型不一致。");
    }
    const url = validateWebhookUrl(
      credential.webhookUrl,
      "qyapi.weixin.qq.com",
      "/cgi-bin/webhook/send",
    );
    // 消息级设置优先于渠道级：失效提醒必须 @所有人，哪怕渠道平时关着 @。
    const mentionAll = message.mentionAll ?? settings.mentionAll;
    const body = mentionAll
      ? {
          msgtype: "text",
          text: { content: message.text, mentioned_list: ["@all"] },
        }
      : { msgtype: "markdown", markdown: { content: message.markdown } };
    const response = await postJson(url, body);
    const result = asRecord(await response.json());
    if (Number(result.errcode) !== 0) {
      throw new Error(`企业微信返回错误：${safeRemoteMessage(result.errmsg)}`);
    }
    return { ok: true, message: "企业微信测试消息发送成功。" };
  }
}

export class FeishuNotificationSender implements NotificationSender {
  readonly kind = "feishu" as const;

  async send(
    settings: NotificationChannelSettings,
    credential: NotificationCredentialInput,
    message: NotificationRenderedMessage,
  ): Promise<NotificationSendResult> {
    if (settings.kind !== this.kind || credential.kind !== this.kind) {
      throw new Error("飞书通知配置类型不一致。");
    }
    const url = validateWebhookUrl(
      credential.webhookUrl,
      "open.feishu.cn",
      "/open-apis/bot/v2/hook/",
    );
    const body: Record<string, unknown> = {
      msg_type: "text",
      content: {
        text: `${message.text}${(message.mentionAll ?? settings.mentionAll) ? "\n<at user_id=\"all\">所有人</at>" : ""}`,
      },
    };
    if (credential.signingSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const stringToSign = `${timestamp}\n${credential.signingSecret}`;
      body.timestamp = String(timestamp);
      body.sign = createHmac("sha256", stringToSign)
        .update("")
        .digest("base64");
    }
    const response = await postJson(url, body);
    const result = asRecord(await response.json());
    const code = Number(result.code ?? result.StatusCode ?? 0);
    if (code !== 0) {
      throw new Error(
        `飞书返回错误：${safeRemoteMessage(result.msg ?? result.StatusMessage)}`,
      );
    }
    return { ok: true, message: "飞书测试消息发送成功。" };
  }
}

async function postJson(url: URL, body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`通知请求失败（HTTP ${response.status}）。`);
  }
  return response;
}

function validateWebhookUrl(
  value: string,
  hostname: string,
  pathPrefix: string,
): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== hostname ||
    !url.pathname.startsWith(pathPrefix) ||
    url.username ||
    url.password
  ) {
    throw new Error("Webhook 地址不是受支持的官方 HTTPS 地址。");
  }
  return url;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function safeRemoteMessage(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.slice(0, 300)
    : "未知错误";
}
