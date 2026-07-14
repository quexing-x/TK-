import type {
  NotificationChannelKind,
  NotificationChannelSettings,
  NotificationCredentialInput,
  NotificationRenderedMessage,
} from "@tk-auto/core";

export interface NotificationSendResult {
  ok: boolean;
  message: string;
}
export interface NotificationSender {
  readonly kind: NotificationChannelKind;
  send(
    settings: NotificationChannelSettings,
    credential: NotificationCredentialInput,
    message: NotificationRenderedMessage,
  ): Promise<NotificationSendResult>;
}
