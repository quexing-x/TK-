import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  NotificationChannelSettings,
  NotificationCredentialInput,
  NotificationRenderedMessage,
} from "@tk-auto/core";
import { InMemoryCredentialVault } from "@tk-auto/credentials";
import {
  NotificationSenderRegistry,
  type NotificationSender,
} from "@tk-auto/notifications";
import { AutomationStore } from "@tk-auto/storage";
import { NotificationService } from "./notification-service.js";

class FakeWecomSender implements NotificationSender {
  readonly kind = "wecom" as const;
  messages: NotificationRenderedMessage[] = [];
  shouldFail = false;

  async send(
    _settings: NotificationChannelSettings,
    _credential: NotificationCredentialInput,
    message: NotificationRenderedMessage,
  ) {
    if (this.shouldFail) {
      throw new Error(
        "request failed https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret",
      );
    }
    this.messages.push(message);
    return { ok: true, message: "测试成功" };
  }
}

describe("NotificationService", () => {
  let store: AutomationStore;
  let vault: InMemoryCredentialVault;
  let sender: FakeWecomSender;
  let service: NotificationService;

  beforeEach(async () => {
    store = new AutomationStore(":memory:");
    store.seed();
    vault = new InMemoryCredentialVault();
    sender = new FakeWecomSender();
    service = new NotificationService(
      store,
      vault,
      new NotificationSenderRegistry([sender]),
    );
    store.saveNotificationChannelSettings({
      kind: "wecom",
      enabled: true,
      mentionAll: false,
    });
    const reference = await vault.create(
      JSON.stringify({
        kind: "wecom",
        webhookUrl:
          "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret",
      }),
    );
    store.setNotificationCredentialReference("wecom", reference);
  });

  afterEach(() => store.close());

  it("tests a channel and sends a completed no-action cycle", async () => {
    const channel = await service.testChannel("wecom");
    expect(channel.status).toBe("ready");
    const cycle = store.createPollCycle();
    store.savePollAccountResult(cycle.id, {
      accountId: "demo-account",
      accountName: "演示广告账户",
      runId: "run-1",
      status: "no-action",
      enabledCount: 0,
      disabledCount: 0,
      failureCount: 0,
      message: null,
    });

    await service.enqueueAndDispatch(store.finishPollCycle(cycle.id));

    expect(store.listNotificationDeliveries()[0]?.status).toBe("sent");
    expect(sender.messages.at(-1)?.text).toContain("演示广告账户：无操作");
  });

  it("records a safe channel error without exposing the webhook", async () => {
    sender.shouldFail = true;

    const channel = await service.testChannel("wecom");

    expect(channel.status).toBe("failed");
    expect(channel.lastMessage).toContain("[已隐藏地址]");
    expect(channel.lastMessage).not.toContain("key=secret");
  });
});
