import {
  NotificationCredentialInputSchema,
  type NotificationChannelKind,
  type NotificationChannelRecord,
  type NotificationDeliveryRecord,
  type NotificationRenderedMessage,
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

  /**
   * 立即把一条余额告警发往所有已启用渠道，返回「是否算已触达」。
   *
   * 与轮询汇总的投递记录不同，这里没有 retry 队列：告警的去重状态由调用方管——
   * 它只有**发送成功或确认无渠道可发**之后才落「已提醒」，发全失败就保持未提醒，
   * 下一个 15 分钟的余额刷新会自然重试。部分渠道成功也算已触达：失败的那个渠道
   * 是配置/网络问题，让它把同步告警变成每 15 分钟一次的全渠道重发，反而会骚扰。
   *
   * return true  = 已触达或无需再试（调用方应记「已提醒」）
   * return false = 全部已启用渠道都发送失败（调用方不记，等下次重试）
   */
  async deliverBalanceAlert(
    message: NotificationRenderedMessage,
  ): Promise<{ acknowledged: boolean; errors: string[] }> {
    const kinds: NotificationChannelKind[] = ["email", "wecom", "feishu"];
    const sendable: Array<{ kind: NotificationChannelKind }> = [];
    const unavailable: string[] = [];
    for (const kind of kinds) {
      try {
        const context = await this.loadChannel(kind);
        if (!context.settings.enabled) continue;
        sendable.push({ kind });
      } catch {
        // 未配置渠道/凭据是预期的常态，不是错误；不进 errors。
      }
    }
    if (sendable.length === 0) {
      // 一个启用的渠道都没有：现在没处可发，但告警本身是成立的，记「已提醒」
      // 免得余额一直低的时候每 15 分钟空转一轮。
      return { acknowledged: true, errors: [] };
    }
    const errors: string[] = [];
    const delivered: boolean[] = [];
    for (const { kind } of sendable) {
      try {
        const context = await this.loadChannel(kind);
        const result = await this.senders
          .get(kind)
          .send(context.settings, context.credential, message);
        delivered.push(result.ok);
        if (!result.ok) errors.push(`${kind}：${result.message}`);
      } catch (cause) {
        delivered.push(false);
        errors.push(`${kind}：${safeNotificationError(cause)}`);
      }
    }
    const acknowledged = delivered.some(Boolean);
    return { acknowledged, errors: errors.filter(Boolean) };
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
