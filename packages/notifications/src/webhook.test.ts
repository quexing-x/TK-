import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTestMessage } from "./format.js";
import {
  FeishuNotificationSender,
  WecomNotificationSender,
} from "./webhook.js";

describe("webhook notification senders", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects non-official enterprise WeChat webhook hosts", async () => {
    const sender = new WecomNotificationSender();
    await expect(
      sender.send(
        { kind: "wecom", enabled: true, mentionAll: false },
        { kind: "wecom", webhookUrl: "https://example.com/hook" },
        renderTestMessage(),
      ),
    ).rejects.toThrow("官方 HTTPS");
  });

  it("uses the official text mention list when enterprise WeChat should notify everyone", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sender = new WecomNotificationSender();

    await sender.send(
      { kind: "wecom", enabled: true, mentionAll: true },
      {
        kind: "wecom",
        webhookUrl:
          "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=example-token",
      },
      renderTestMessage(),
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { msgtype: string; text: { mentioned_list: string[] } };
    expect(body.msgtype).toBe("text");
    expect(body.text.mentioned_list).toEqual(["@all"]);
  });

  it("adds a Feishu signature without exposing the secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sender = new FeishuNotificationSender();
    await sender.send(
      { kind: "feishu", enabled: true, mentionAll: false },
      {
        kind: "feishu",
        webhookUrl:
          "https://open.feishu.cn/open-apis/bot/v2/hook/example-token",
        signingSecret: "top-secret",
      },
      renderTestMessage(),
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(body.sign).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("top-secret");
  });
});
