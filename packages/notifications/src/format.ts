import type {
  NotificationRenderedMessage,
  PollAccountResult,
  PollCycleRecord,
} from "@tk-auto/core";

/**
 * 刚刚失效的、且自动化开着的账户。
 *
 * 只传「刚跳变的」，不是「当前所有失效的」：账户失效会持续几小时甚至几天，每轮
 * 轮询都 @所有人 会把群刷爆（轮询间隔最短 45 秒）。判据放在调用方，这里只负责渲染。
 */
export interface InvalidAutomationAccount {
  accountName: string;
  message: string | null;
}

export function renderPollCycle(
  cycle: PollCycleRecord,
  newlyInvalid: readonly InvalidAutomationAccount[] = [],
): NotificationRenderedMessage {
  const totals = summarize(cycle.accounts);
  const finishedAt = cycle.finishedAt ?? cycle.startedAt;
  const displayTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(finishedAt));
  // 失效提醒盖过常规汇总标题：这条要让人一眼看出是出事了，不是例行报告。
  const subject = newlyInvalid.length > 0
    ? `TK Ads 账户失效：${newlyInvalid.length} 个已开启自动化的账户连接异常`
    : `TK Ads 轮询报告：开启 ${totals.enabled} / 关闭 ${totals.disabled} / 无操作 ${totals.noAction}`;
  const alertText = newlyInvalid.length > 0
    ? [
        `⚠️ 以下 ${newlyInvalid.length} 个账户已开启自动化，但连接失效，投放正在停摆：`,
        ...newlyInvalid.map((item) =>
          `  · ${item.accountName}${item.message ? `：${item.message}` : ""}`),
        "请尽快到「用户管理」重新导入 Cookie 或检查接入。",
        "",
      ]
    : [];
  const alertMarkdown = newlyInvalid.length > 0
    ? [
        `## ⚠️ ${newlyInvalid.length} 个已开启自动化的账户连接失效`,
        ...newlyInvalid.map((item) =>
          `- **${item.accountName}**${item.message ? `：${item.message}` : ""}`),
        "",
        "请尽快到「用户管理」重新导入 Cookie 或检查接入。",
        "",
      ]
    : [];
  const alertHtml = newlyInvalid.length > 0
    ? `<div style="border-left:4px solid #d33;padding:8px 12px;margin-bottom:12px">
        <p><strong>⚠️ ${newlyInvalid.length} 个已开启自动化的账户连接失效，投放正在停摆</strong></p>
        <ul>${newlyInvalid.map((item) =>
          `<li>${escapeHtml(item.accountName)}${item.message ? `：${escapeHtml(item.message)}` : ""}</li>`).join("")}</ul>
        <p>请尽快到「用户管理」重新导入 Cookie 或检查接入。</p>
      </div>`
    : "";
  const summary = `汇总：开启 ${totals.enabled}，关闭 ${totals.disabled}，无操作 ${totals.noAction}，失败 ${totals.failed}，跳过 ${totals.skipped}`;
  const textRows = cycle.accounts.map(formatTextAccount);
  const markdownRows = cycle.accounts.map(formatMarkdownAccount);
  const htmlRows = cycle.accounts.map(formatHtmlAccount).join("");

  return {
    subject,
    // 有失效账户时强制 @所有人，覆盖渠道自身的 mentionAll 设置。
    ...(newlyInvalid.length > 0 ? { mentionAll: true } : {}),
    text: [
      ...alertText,
      "TK Ads 自动化轮询报告",
      `完成时间：${displayTime}`,
      summary,
      "",
      ...textRows,
    ].join("\n"),
    markdown: [
      ...alertMarkdown,
      "# TK Ads 自动化轮询报告",
      `> 完成时间：${displayTime}`,
      `**${summary}**`,
      "",
      ...markdownRows,
    ].join("\n"),
    html: `
      ${alertHtml}
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
