import type {
  NotificationRenderedMessage,
  PollAccountResult,
  PollCycleRecord,
} from "@tk-auto/core";

export function renderPollCycle(
  cycle: PollCycleRecord,
): NotificationRenderedMessage {
  const totals = summarize(cycle.accounts);
  const finishedAt = cycle.finishedAt ?? cycle.startedAt;
  const displayTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(finishedAt));
  const subject = `TK Ads 轮询报告：开启 ${totals.enabled} / 关闭 ${totals.disabled} / 无操作 ${totals.noAction}`;
  const summary = `汇总：开启 ${totals.enabled}，关闭 ${totals.disabled}，无操作 ${totals.noAction}，失败 ${totals.failed}，跳过 ${totals.skipped}`;
  const textRows = cycle.accounts.map(formatTextAccount);
  const markdownRows = cycle.accounts.map(formatMarkdownAccount);
  const htmlRows = cycle.accounts.map(formatHtmlAccount).join("");

  return {
    subject,
    text: [
      "TK Ads 自动化轮询报告",
      `完成时间：${displayTime}`,
      summary,
      "",
      ...textRows,
    ].join("\n"),
    markdown: [
      "# TK Ads 自动化轮询报告",
      `> 完成时间：${displayTime}`,
      `**${summary}**`,
      "",
      ...markdownRows,
    ].join("\n"),
    html: `
      <h2>TK Ads 自动化轮询报告</h2>
      <p>完成时间：${escapeHtml(displayTime)}</p>
      <p><strong>${escapeHtml(summary)}</strong></p>
      <table style="border-collapse:collapse;width:100%">
        <thead><tr>
          <th style="border:1px solid #ddd;padding:8px">账户</th>
          <th style="border:1px solid #ddd;padding:8px">结果</th>
          <th style="border:1px solid #ddd;padding:8px">开启</th>
          <th style="border:1px solid #ddd;padding:8px">关闭</th>
          <th style="border:1px solid #ddd;padding:8px">失败</th>
          <th style="border:1px solid #ddd;padding:8px">说明</th>
        </tr></thead>
        <tbody>${htmlRows}</tbody>
      </table>
    `.trim(),
  };
}
export function renderTestMessage(): NotificationRenderedMessage {
  const text =
    "TK Ads 消息推送测试成功。此消息用于验证通知渠道配置，不包含真实广告数据。";
  return {
    subject: "TK Ads 消息推送测试",
    text,
    markdown: `**TK Ads 消息推送测试**\n\n${text}`,
    html: `<h2>TK Ads 消息推送测试</h2><p>${text}</p>`,
  };
}

function summarize(accounts: PollAccountResult[]) {
  return accounts.reduce(
    (total, account) => {
      total.enabled += account.enabledCount;
      total.disabled += account.disabledCount;
      if (account.status === "no-action") total.noAction += 1;
      if (account.status === "failed") total.failed += 1;
      if (account.status === "skipped") total.skipped += 1;
      return total;
    },
    { enabled: 0, disabled: 0, noAction: 0, failed: 0, skipped: 0 },
  );
}

function formatTextAccount(account: PollAccountResult): string {
  return `- ${account.accountName}：${statusLabel(account)}，开启 ${account.enabledCount}，关闭 ${account.disabledCount}，失败 ${account.failureCount}${account.message ? `；${account.message}` : ""}`;
}

function formatMarkdownAccount(account: PollAccountResult): string {
  return `- **${escapeMarkdown(account.accountName)}**：${statusLabel(account)}；开启 ${account.enabledCount}，关闭 ${account.disabledCount}，失败 ${account.failureCount}${account.message ? `；${escapeMarkdown(account.message)}` : ""}`;
}

function formatHtmlAccount(account: PollAccountResult): string {
  const values = [
    account.accountName,
    statusLabel(account),
    String(account.enabledCount),
    String(account.disabledCount),
    String(account.failureCount),
    account.message ?? "—",
  ];
  return `<tr>${values
    .map(
      (value) =>
        `<td style="border:1px solid #ddd;padding:8px">${escapeHtml(value)}</td>`,
    )
    .join("")}</tr>`;
}

function statusLabel(account: PollAccountResult): string {
  if (account.status === "changed") return "已执行";
  if (account.status === "no-action") return "无操作";
  if (account.status === "failed") return "执行失败";
  return "已跳过";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}
