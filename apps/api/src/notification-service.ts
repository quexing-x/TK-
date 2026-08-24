import {
  NotificationCredentialInputSchema,
  type NotificationChannelKind,
  type NotificationChannelRecord,
  type NotificationDeliveryRecord,
  type PollCycleRecord,
} from "@tk-auto/core";
import type { CredentialVault } from "@tk-auto/credentials";
import {
  NotificationSenderRegistry,
  renderPollCycle,
  renderTestMessage,
} from "@tk-auto/notifications";
import { AutomationStore } from "@tk-auto/storage";

export class NotificationService {
  constructor(
    private readonly store: AutomationStore,
    private readonly vault: CredentialVault,
    private readonly senders = new NotificationSenderRegistry(),
  ) {}

  async testChannel(
    kind: NotificationChannelKind,
  ): Promise<NotificationChannelRecord> {
    try {
      const context = await this.loadChannel(kind);
      const result = await this.senders
        .get(kind)
        .send(context.settings, context.credential, renderTestMessage());
      return this.store.updateNotificationChannelStatus(
        kind,
        "ready",
        result.message,
      );
    } catch (cause) {
      return this.store.updateNotificationChannelStatus(
        kind,
        "failed",
        safeNotificationError(cause),
      );
    }
  }

  async enqueueAndDispatch(cycle: PollCycleRecord): Promise<void> {
    if (cycle.status !== "completed" || cycle.accounts.length === 0) return;
    this.store.enqueueNotificationDeliveries(cycle.id);
    await this.flushPending();
  }

  async flushPending(): Promise<void> {
    const deliveries = this.store.listDueNotificationDeliveries();
    await Promise.allSettled(
      deliveries.map((delivery) => this.deliver(delivery)),
    );
  }

  private async deliver(delivery: NotificationDeliveryRecord): Promise<void> {
    const sending = this.store.markNotificationDeliverySending(delivery.id);
    try {
      const cycle = this.store.getPollCycle(sending.cycleId);
      if (!cycle || cycle.status !== "completed") {
        throw new Error("通知对应的轮询批次尚未完成。");
      }
      const context = await this.loadChannel(sending.channelKind);
      // 失效提醒随本批次的汇总一起发，并强制 @所有人。只带「刚跳变成失效」的账户，
      // 持续失效不会每轮重复轰炸（判据见 listNewlyInvalidAutomationAccounts）。
      const newlyInvalid = this.store.listNewlyInvalidAutomationAccounts(cycle.id);
      await this.senders
        .get(sending.channelKind)
        .send(context.settings, context.credential, renderPollCycle(cycle, newlyInvalid));
      this.store.markNotificationDeliverySent(sending.id);
    } catch (cause) {
      this.store.markNotificationDeliveryFailed(
        sending.id,
        safeNotificationError(cause),
      );
    }
  }

  private async loadChannel(kind: NotificationChannelKind) {
    const channel = this.store.getNotificationChannel(kind);
    if (!channel?.settings) throw new Error("请先保存通知渠道参数。");
    if (!channel.credentialRef) throw new Error("请先保存通知渠道凭据。");
    const secret = await this.vault.read(channel.credentialRef);
    if (!secret) throw new Error("通知凭据引用已经失效，请重新保存。");
    const credential = NotificationCredentialInputSchema.parse(
      JSON.parse(secret),
    );
    if (credential.kind !== kind || channel.settings.kind !== kind) {
      throw new Error("通知渠道配置类型不一致。");
    }
    return { settings: channel.settings, credential };
  }
}
function safeNotificationError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "通知发送失败。";
  return message
    .replace(/https:\/\/[^\s]+/gi, "[已隐藏地址]")
    .replace(/([?&]key=)[^&\s]+/gi, "$1[已隐藏]")
    .slice(0, 1000);
}
