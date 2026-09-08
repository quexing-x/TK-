import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ExternalLink,
  Mail,
  MessageSquareText,
  RefreshCcw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
} from "./ui/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  NotificationChannelKind,
  NotificationChannelRecord,
  NotificationChannelSettings,
  NotificationConnectionStatus,
  NotificationDeliveryRecord,
  PollCycleRecord,
} from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import { useOverlays } from "./ui/overlays";
import "./ui/pages/notifications-manual.css";

type EmailSettings = Extract<
  NotificationChannelSettings,
  { kind: "email" }
>;
type WecomSettings = Extract<
  NotificationChannelSettings,
  { kind: "wecom" }
>;
type FeishuSettings = Extract<
  NotificationChannelSettings,
  { kind: "feishu" }
>;

const defaultEmail: EmailSettings = {
  kind: "email",
  enabled: false,
  smtpHost: "smtp.qq.com",
  smtpPort: 465,
  secure: true,
  from: "",
  recipients: [],
};

const defaultWecom: WecomSettings = {
  kind: "wecom",
  enabled: false,
  mentionAll: false,
};

const defaultFeishu: FeishuSettings = {
  kind: "feishu",
  enabled: false,
  mentionAll: false,
};

export function NotificationsPage({
  onError,
}: {
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { confirm, toast } = useOverlays();
  const canManageRules = auth.status.permissions.includes("rules:manage");
  const [channels, setChannels] = useState<NotificationChannelRecord[]>([]);
  const [activeChannel, setActiveChannel] = useState<"email" | "wecom" | "feishu" | "history">("email");
  const [deliveries, setDeliveries] = useState<NotificationDeliveryRecord[]>([]);
  const [cycles, setCycles] = useState<PollCycleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});

  const [email, setEmail] = useState(defaultEmail);
  const [recipientText, setRecipientText] = useState("");
  const [emailUsername, setEmailUsername] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [wecom, setWecom] = useState(defaultWecom);
  const [wecomWebhook, setWecomWebhook] = useState("");
  const [feishu, setFeishu] = useState(defaultFeishu);
  const [feishuWebhook, setFeishuWebhook] = useState("");
  const [feishuSecret, setFeishuSecret] = useState("");

  const load = useCallback(async () => {
    try {
      const [nextChannels, nextDeliveries, nextCycles] = await Promise.all([
        api.getNotificationChannels(),
        api.getNotificationDeliveries(),
        api.getPollCycles(),
      ]);
      setChannels(nextChannels);
      setDeliveries(nextDeliveries);
      setCycles(nextCycles);
      const savedEmail = nextChannels.find((item) => item.kind === "email")
        ?.settings;
      const savedWecom = nextChannels.find((item) => item.kind === "wecom")
        ?.settings;
      const savedFeishu = nextChannels.find((item) => item.kind === "feishu")
        ?.settings;
      if (savedEmail?.kind === "email") {
        setEmail(savedEmail);
        setRecipientText(savedEmail.recipients.join(", "));
      }
      if (savedWecom?.kind === "wecom") setWecom(savedWecom);
      if (savedFeishu?.kind === "feishu") setFeishu(savedFeishu);
      onError(null);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const channelMap = useMemo(
    () => new Map(channels.map((channel) => [channel.kind, channel])),
    [channels],
  );

  const runAction = async (
    key: string,
    action: () => Promise<void>,
    successMessage: string,
  ) => {
    if (!canManageRules) return;
    try {
      setBusy(key);
      setFeedback((current) => ({ ...current, [key]: "" }));
      await action();
      await load();
      setFeedback((current) => ({ ...current, [key]: successMessage }));
      toast(successMessage);
      onError(null);
    } catch (cause) {
      const message = errorMessage(cause);
      setFeedback((current) => ({ ...current, [key]: message }));
      onError(message);
    } finally {
      setBusy(null);
    }
  };

  const saveEmail = () =>
    runAction(
      "email",
      async () => {
        const recipients = splitRecipients(recipientText);
        if (emailUsername || emailPassword) {
          if (!emailUsername || !emailPassword) {
            throw new Error("更新邮箱凭据时，SMTP 用户名和授权码必须同时填写。");
          }
        }
        await api.saveNotificationSettings("email", { ...email, recipients });
        if (emailUsername && emailPassword) {
          await api.saveNotificationCredential("email", {
            kind: "email",
            username: emailUsername,
            password: emailPassword,
          });
          setEmailUsername("");
          setEmailPassword("");
        }
      },
      "邮箱配置已保存。请发送测试消息，测试通过后才会进入自动推送。",
    );

  const saveWecom = () =>
    runAction(
      "wecom",
      async () => {
        await api.saveNotificationSettings("wecom", wecom);
        if (wecomWebhook.trim()) {
          await api.saveNotificationCredential("wecom", {
            kind: "wecom",
            webhookUrl: wecomWebhook.trim(),
          });
          setWecomWebhook("");
        }
      },
      "企业微信配置已保存。请发送测试消息，测试通过后才会进入自动推送。",
    );

  const saveFeishu = () =>
    runAction(
      "feishu",
      async () => {
        if (!feishuWebhook.trim() && feishuSecret.trim()) {
          throw new Error("更新飞书签名密钥时，需要同时填写 Webhook 地址。");
        }
        await api.saveNotificationSettings("feishu", feishu);
        if (feishuWebhook.trim()) {
          const signingSecret = feishuSecret.trim();
          await api.saveNotificationCredential("feishu", {
            kind: "feishu",
            webhookUrl: feishuWebhook.trim(),
            ...(signingSecret ? { signingSecret } : {}),
          });
          setFeishuWebhook("");
          setFeishuSecret("");
        }
      },
      "飞书配置已保存。请发送测试消息，测试通过后才会进入自动推送。",
    );

  const testChannel = (kind: NotificationChannelKind) =>
    runAction(
      kind,
      async () => {
        const result = await api.testNotificationChannel(kind);
        if (result.status !== "ready") {
          throw new Error(result.lastMessage ?? "测试消息发送失败。");
        }
      },
      "测试消息发送成功，渠道已就绪。",
    );

  const deleteCredential = async (kind: NotificationChannelKind) => {
    if (!await confirm({ title: "删除渠道凭据", message: "确认删除该渠道的本机加密凭据吗？渠道参数会保留。", confirmLabel: "删除凭据", danger: true })) return;
    void runAction(
      kind,
      async () => {
        await api.deleteNotificationCredential(kind);
      },
      "凭据已删除，该渠道不会继续推送。",
    );
  };

  if (loading) {
    return <div className="empty-state"><div className="loader" />正在读取推送配置…</div>;
  }

  return (
    <section className="page-stack notification-page">
      {!canManageRules && <div className="alert warning-alert"><ShieldCheck size={18} /><span>当前角色仅可查看通知配置；保存、测试和删除凭据需要 rules:manage 权限。</span></div>}
      <header className="notification-page-heading">
        <div>
          <span className="eyebrow">系统通知中心</span>
          <p>配置并验证自动化轮询结果的推送渠道。</p>
        </div>
        <button className="secondary-button" onClick={() => void load()} type="button">
          <RefreshCcw size={16} />刷新状态
        </button>
      </header>

      <div className="notification-workspace">
        <aside className="notification-workspace-nav panel" aria-label="推送配置导航">
          <div className="notification-nav-heading">
            <BellRing size={18} />
            <div><strong>推送配置</strong><span>3 个可用渠道</span></div>
          </div>
          <nav>
            <button className={activeChannel === "email" ? "active" : ""} onClick={() => setActiveChannel("email")} type="button">
              <Mail size={16} /><span>邮箱 SMTP</span><StatusBadge status={channelMap.get("email")?.status ?? "not-configured"} />
            </button>
            <button className={activeChannel === "wecom" ? "active" : ""} onClick={() => setActiveChannel("wecom")} type="button">
              <MessageSquareText size={16} /><span>企业微信</span><StatusBadge status={channelMap.get("wecom")?.status ?? "not-configured"} />
            </button>
            <button className={activeChannel === "feishu" ? "active" : ""} onClick={() => setActiveChannel("feishu")} type="button">
              <Send size={16} /><span>飞书</span><StatusBadge status={channelMap.get("feishu")?.status ?? "not-configured"} />
            </button>
            <button className={activeChannel === "history" ? "active" : ""} onClick={() => setActiveChannel("history")} type="button">
              <RefreshCcw size={16} /><span>推送记录</span>
            </button>
          </nav>
        </aside>

        <div className="notification-workspace-main">
          <div className="notification-hero panel">
            <span className="notification-hero-icon"><BellRing size={24} /></span>
            <div>
              <span className="eyebrow">轮询结果通知</span>
              <h2>每轮自动化结束后发送一份汇总</h2>
              <p>仅在存在到期账户并实际完成一轮轮询后发送，按账户统计开启、关闭、无操作、失败和跳过；空轮询不发送，推送失败也不会阻断广告启停。</p>
            </div>
          </div>

          <fieldset className="notification-channel-grid" disabled={!canManageRules} style={{ border: 0, margin: 0, minInlineSize: 0, padding: 0 }}>
        {activeChannel === "email" && (<ChannelCard
          id="notification-email"
          channel={channelMap.get("email")}
          icon={<Mail size={21} />}
          title="邮箱 SMTP"
          description="通过现有邮箱服务商的 SMTP 服务发送 HTML 汇总邮件。"
        >
          <div className="notification-form-grid">
            <Field label="SMTP 服务器"><input value={email.smtpHost} onChange={(event) => setEmail({ ...email, smtpHost: event.target.value })} /></Field>
            <Field label="端口"><input min="1" max="65535" type="number" value={email.smtpPort} onChange={(event) => setEmail({ ...email, smtpPort: Number(event.target.value) })} /></Field>
            <Field label="发件邮箱"><input type="email" value={email.from} onChange={(event) => setEmail({ ...email, from: event.target.value })} /></Field>
            <Field label="收件邮箱（逗号或换行分隔）"><input value={recipientText} onChange={(event) => setRecipientText(event.target.value)} /></Field>
            <Field label="SMTP 用户名"><input autoComplete="off" placeholder={channelMap.get("email")?.hasCredential ? "留空则保留现有凭据" : "通常为完整邮箱地址"} value={emailUsername} onChange={(event) => setEmailUsername(event.target.value)} /></Field>
            <Field label="SMTP 授权码 / 密码"><input autoComplete="new-password" placeholder={channelMap.get("email")?.hasCredential ? "留空则保留现有凭据" : "请使用服务商生成的授权码"} type="password" value={emailPassword} onChange={(event) => setEmailPassword(event.target.value)} /></Field>
          </div>
          <div className="notification-switches">
            <Switch checked={email.enabled} label="启用邮箱推送" onChange={(enabled) => setEmail({ ...email, enabled })} />
            <Switch checked={email.secure} label="使用 SSL/TLS（通常为 465 端口）" onChange={(secure) => setEmail({ ...email, secure })} />
          </div>
          <ChannelActions canManage={canManageRules} kind="email" busy={busy} feedback={feedback.email} hasCredential={channelMap.get("email")?.hasCredential ?? false} onDelete={deleteCredential} onSave={() => void saveEmail()} onTest={(kind) => void testChannel(kind)} />
          <Tutorial
            docsUrl="https://nodemailer.com/smtp"
            steps={[
              "在邮箱服务商后台开启 SMTP，并生成客户端授权码；不要直接使用日常登录密码。",
              "填写 SMTP 服务器、端口、TLS、发件地址与收件地址，再填写用户名和授权码。",
              "先保存，再发送测试消息；状态显示“已就绪”后才会参与轮询推送。",
            ]}
            title="邮箱接入教程"
          />
        </ChannelCard>)}

        {activeChannel === "wecom" && (<ChannelCard
          id="notification-wecom"
          channel={channelMap.get("wecom")}
          icon={<MessageSquareText size={21} />}
          title="企业微信群机器人"
          description="通过企业微信群自定义机器人 Webhook 发送 Markdown 汇总。"
        >
          <div className="notification-form-grid single-column">
            <Field label="机器人 Webhook（加密保存）"><input autoComplete="new-password" placeholder={channelMap.get("wecom")?.hasCredential ? "留空则保留现有 Webhook" : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"} type="password" value={wecomWebhook} onChange={(event) => setWecomWebhook(event.target.value)} /></Field>
          </div>
          <div className="notification-switches">
            <Switch checked={wecom.enabled} label="启用企业微信推送" onChange={(enabled) => setWecom({ ...wecom, enabled })} />
            <Switch checked={wecom.mentionAll} label="消息中提醒所有人" onChange={(mentionAll) => setWecom({ ...wecom, mentionAll })} />
          </div>
          <ChannelActions canManage={canManageRules} kind="wecom" busy={busy} feedback={feedback.wecom} hasCredential={channelMap.get("wecom")?.hasCredential ?? false} onDelete={deleteCredential} onSave={() => void saveWecom()} onTest={(kind) => void testChannel(kind)} />
          <Tutorial
            docsUrl="https://developer.work.weixin.qq.com/document/path/91770"
            steps={[
              "在目标企业微信群中添加“群机器人”，设置名称并复制机器人 Webhook。",
              "粘贴 Webhook，按需开启提醒所有人，然后保存配置。",
              "发送测试消息；测试通过后，系统会在每个实际轮询批次结束时推送。",
            ]}
            title="企业微信接入教程"
          />
        </ChannelCard>)}

        {activeChannel === "feishu" && (<ChannelCard
          id="notification-feishu"
          channel={channelMap.get("feishu")}
          icon={<Send size={21} />}
          title="飞书群自定义机器人"
          description="通过飞书自定义机器人 Webhook 发送文本汇总，支持签名校验。"
        >
          <div className="notification-form-grid single-column">
            <Field label="机器人 Webhook（加密保存）"><input autoComplete="new-password" placeholder={channelMap.get("feishu")?.hasCredential ? "留空则保留现有 Webhook" : "https://open.feishu.cn/open-apis/bot/v2/hook/…"} type="password" value={feishuWebhook} onChange={(event) => setFeishuWebhook(event.target.value)} /></Field>
            <Field label="签名密钥（可选，加密保存）"><input autoComplete="new-password" placeholder={channelMap.get("feishu")?.hasCredential ? "替换凭据时与 Webhook 一起填写" : "机器人安全设置中的签名密钥"} type="password" value={feishuSecret} onChange={(event) => setFeishuSecret(event.target.value)} /></Field>
          </div>
          <div className="notification-switches">
            <Switch checked={feishu.enabled} label="启用飞书推送" onChange={(enabled) => setFeishu({ ...feishu, enabled })} />
            <Switch checked={feishu.mentionAll} label="消息中提醒所有人" onChange={(mentionAll) => setFeishu({ ...feishu, mentionAll })} />
          </div>
          <ChannelActions canManage={canManageRules} kind="feishu" busy={busy} feedback={feedback.feishu} hasCredential={channelMap.get("feishu")?.hasCredential ?? false} onDelete={deleteCredential} onSave={() => void saveFeishu()} onTest={(kind) => void testChannel(kind)} />
          <Tutorial
            docsUrl="https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN"
            steps={[
              "在目标飞书群中添加“自定义机器人”，复制 Webhook，并按需启用签名校验。",
              "粘贴 Webhook；若启用了签名校验，同时填写机器人安全设置中的签名密钥。",
              "保存后发送测试消息；测试通过后渠道状态会变为“已就绪”。",
            ]}
            title="飞书接入教程"
          />
        </ChannelCard>)}
          </fieldset>

          {activeChannel === "history" && <div id="notification-history"><HistoryTables deliveries={deliveries} cycles={cycles} /></div>}
        </div>
      </div>
    </section>
  );
}

function ChannelCard({
  id,
  channel,
  icon,
  title,
  description,
  children,
}: {
  id: string;
  channel: NotificationChannelRecord | undefined;
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <article className="notification-channel panel" id={id}>
      <header>
        <span className="notification-channel-icon">{icon}</span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <StatusBadge status={channel?.status ?? "not-configured"} />
      </header>
      {channel?.lastMessage && (
        <div className={channel.status === "failed" ? "channel-message failed" : "channel-message"}>
          {channel.status === "failed" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{channel.lastMessage}{channel.lastTestedAt ? ` · ${formatTime(channel.lastTestedAt)}` : ""}</span>
        </div>
      )}
      {children}
    </article>
  );
}

function ChannelActions({
  canManage,
  kind,
  busy,
  feedback,
  hasCredential,
  onSave,
  onTest,
  onDelete,
}: {
  canManage: boolean;
  kind: NotificationChannelKind;
  busy: string | null;
  feedback: string | undefined;
  hasCredential: boolean;
  onSave: () => void;
  onTest: (kind: NotificationChannelKind) => void;
  onDelete: (kind: NotificationChannelKind) => void;
}) {
  const working = busy === kind;
  return (
    <div className="notification-actions">
      <span className="credential-state"><ShieldCheck size={14} />{hasCredential ? "凭据已在本机加密保存" : "尚未保存凭据"}</span>
      <div>
        {hasCredential && <button className="danger-button compact-button" disabled={working || !canManage} onClick={() => onDelete(kind)} type="button"><Trash2 size={14} />删除凭据</button>}
        <button className="secondary-button compact-button" disabled={working || !hasCredential || !canManage} onClick={() => onTest(kind)} type="button"><Send size={14} />发送测试</button>
        <button className="primary-button compact-button" disabled={working || !canManage} onClick={onSave} type="button"><Save size={14} />{working ? "处理中…" : "保存配置"}</button>
      </div>
      {feedback && <small>{feedback}</small>}
    </div>
  );
}

function Tutorial({ title, steps, docsUrl }: { title: string; steps: string[]; docsUrl: string }) {
  return (
    <details className="notification-tutorial">
      <summary>{title}<span>展开查看步骤</span></summary>
      <ol>{steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <a href={docsUrl} rel="noreferrer" target="_blank">查看官方接口文档 <ExternalLink size={13} /></a>
    </details>
  );
}

function HistoryTables({ deliveries, cycles }: { deliveries: NotificationDeliveryRecord[]; cycles: PollCycleRecord[] }) {
  return (
    <div className="notification-history-grid">
      <div className="panel table-panel">
        <div className="panel-heading"><div><span className="panel-icon"><BellRing size={18} /></span><div><h2>最近轮询汇总</h2></div></div></div>
        <div className="table-wrap"><table><thead><tr><th>完成时间</th><th>账户数</th><th>开启</th><th>关闭</th><th>无操作</th><th>失败 / 跳过</th></tr></thead><tbody>
          {cycles.length === 0 ? <tr><td colSpan={6}>尚无轮询汇总。</td></tr> : cycles.slice(0, 10).map((cycle) => {
            const summary = summarizeCycle(cycle);
            return <tr key={cycle.id}><td>{formatTime(cycle.finishedAt ?? cycle.startedAt)}</td><td>{cycle.accounts.length}</td><td>{summary.enabled}</td><td>{summary.disabled}</td><td>{summary.noAction}</td><td>{summary.failed} / {summary.skipped}</td></tr>;
          })}
        </tbody></table></div>
      </div>
      <div className="panel table-panel">
        <div className="panel-heading"><div><span className="panel-icon"><Send size={18} /></span><div><h2>最近推送记录</h2></div></div></div>
        <div className="table-wrap"><table><thead><tr><th>创建时间</th><th>渠道</th><th>状态</th><th>尝试次数</th><th>结果</th></tr></thead><tbody>
          {deliveries.length === 0 ? <tr><td colSpan={5}>尚无推送记录。若已配置渠道，说明近期轮询候选为 0、无需推送；推送失败会在此显示并标红。</td></tr> : deliveries.slice(0, 20).map((delivery) => <tr key={delivery.id}><td>{formatTime(delivery.createdAt)}</td><td>{channelLabel(delivery.channelKind)}</td><td><span className={`status ${delivery.status === "sent" ? "active" : delivery.status === "failed" ? "danger" : "warning"}`}>{deliveryStatusLabel(delivery)}</span></td><td>{delivery.attemptCount}</td><td><small>{delivery.lastError ?? (delivery.sentAt ? `发送于 ${formatTime(delivery.sentAt)}` : "等待处理")}</small></td></tr>)}
        </tbody></table></div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label><button aria-label={label} aria-pressed={checked} className={checked ? "toggle checked" : "toggle"} onClick={() => onChange(!checked)} type="button"><span /></button><span>{label}</span></label>;
}

function StatusBadge({ status }: { status: NotificationConnectionStatus }) {
  const className = status === "ready" ? "active" : status === "failed" ? "danger" : status === "untested" ? "warning" : "";
  return <span className={`status ${className}`}>{statusLabel(status)}</span>;
}

function splitRecipients(value: string): string[] {
  const recipients = [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
  if (recipients.length === 0) throw new Error("请至少填写一个收件邮箱。");
  return recipients;
}

function summarizeCycle(cycle: PollCycleRecord) {
  return cycle.accounts.reduce((total, account) => {
    total.enabled += account.enabledCount;
    total.disabled += account.disabledCount;
    if (account.status === "no-action") total.noAction += 1;
    if (account.status === "failed") total.failed += 1;
    if (account.status === "skipped") total.skipped += 1;
    return total;
  }, { enabled: 0, disabled: 0, noAction: 0, failed: 0, skipped: 0 });
}

function statusLabel(status: NotificationConnectionStatus): string {
  if (status === "ready") return "已就绪";
  if (status === "untested") return "待测试";
  if (status === "failed") return "测试失败";
  return "未配置";
}

function channelLabel(kind: NotificationChannelKind): string {
  if (kind === "email") return "邮箱";
  if (kind === "wecom") return "企业微信";
  return "飞书";
}

function deliveryStatusLabel(delivery: NotificationDeliveryRecord): string {
  if (delivery.status === "sent") return "已发送";
  if (delivery.status === "sending") return "发送中";
  if (delivery.status === "failed") {
    return delivery.attemptCount >= 3 ? "发送失败" : "失败待重试";
  }
  return "排队中";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "操作失败，请重试。";
}
