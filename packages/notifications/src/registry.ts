import type { NotificationChannelKind } from "@tk-auto/core";
import { EmailNotificationSender } from "./email.js";
import type { NotificationSender } from "./types.js";
import {
  FeishuNotificationSender,
  WecomNotificationSender,
} from "./webhook.js";

export class NotificationSenderRegistry {
  private readonly senders: Map<NotificationChannelKind, NotificationSender>;

  constructor(
    senders: NotificationSender[] = [
      new EmailNotificationSender(),
      new WecomNotificationSender(),
      new FeishuNotificationSender(),
    ],
  ) {
    this.senders = new Map(senders.map((sender) => [sender.kind, sender]));
  }

  get(kind: NotificationChannelKind): NotificationSender {
    const sender = this.senders.get(kind);
    if (!sender) throw new Error(`未注册通知渠道：${kind}`);
    return sender;
  }
}
