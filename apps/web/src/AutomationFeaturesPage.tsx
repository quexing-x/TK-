import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Copy, FileWarning, Save, Settings2, Trash2 } from "lucide-react";
import type { AutomationFeatureSettingsInput } from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import "./ui/pages/automation-rules.css";

type FeatureKey = "appeal" | "copy" | "deletion";

export function AutomationFeaturesPage({ onError }: { onError: (message: string | null) => void }) {
  const auth = useAuth();
  const canManageRules = auth.status.permissions.includes("rules:manage");
  const [settings, setSettings] = useState<AutomationFeatureSettingsInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<FeatureKey | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

  useEffect(() => {
    void api.getAutomationFeatures()
      .then((value) => setSettings(value))
      .catch((cause) => onError(messageOf(cause)));
  }, [onError]);

  const enabledCount = useMemo(() => settings
    ? Number(settings.appeal.enabled)
      + Number(settings.copy.autoCopyEnabled)
      + Number(settings.deletion.enabled)
    : 0, [settings]);

  const applyAll = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || !canManageRules) return;
    try {
      setSaving(true);
      const result = await api.applyAutomationFeaturesToAllAccounts({
        ...settings,
        copy: {
          ...settings.copy,
          autoCopyLaunchImmediately: true,
          autoCopySameCampaign: true,
        },
        deletion: {
          ...settings.deletion,
          onlyDisabled: true,
          scheduleHour: 6,
          retainOnePerCampaign: true,
        },
      });
      setSettings(result.settings);
      setAppliedMessage(`已将三项执行器开关和规则应用到 ${result.accountCount} 个账户。`);
      onError(null);
    } catch (cause) {
      setAppliedMessage(null);
      onError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="automation-extension-loading" aria-live="polite">
        <span className="loader" />
        <span>正在读取执行器配置…</span>
      </div>
    );
  }

  const toggleHour = (hour: number) => {
    const selected = settings.appeal.scheduleHours.includes(hour);
    if (!selected && settings.appeal.scheduleHours.length >= 6) return;
    const next = selected
      ? settings.appeal.scheduleHours.filter((item) => item !== hour)
      : [...settings.appeal.scheduleHours, hour].sort((left, right) => left - right);
    if (next.length === 0) return;
    setSettings({ ...settings, appeal: { ...settings.appeal, scheduleHours: next } });
  };

  return (
    <details className="automation-extension-section feature-config" open>
      <summary>
        <span className="automation-extension-summary-icon"><Settings2 size={17} /></span>
        <span>
          <strong>自动化执行器</strong>
          <small>申诉、复制和删除均由轮询引擎静默执行；结果未知时禁止自动重试</small>
        </span>
        <span className="automation-extension-state">{enabledCount}/3 已开启</span>
      </summary>
      <form onSubmit={(event) => void applyAll(event)}>
        <div className="automation-extension-toolbar">
          <div>
            <h2>执行器与规则</h2>
            <p>在此统一配置三项功能。点击右侧按钮后，全部开关和规则会一次应用到所有账户。</p>
          </div>
          <button className="primary-button" disabled={saving || !canManageRules} type="submit">
            <Save size={16} /> {saving ? "应用中…" : "一键应用到所有账户"}
          </button>
        </div>
        {appliedMessage && <div className="alert success-alert" role="status">{appliedMessage}</div>}
        {!canManageRules && <div className="alert warning-alert">当前角色只能查看配置；修改需要规则管理权限。</div>}
        <fieldset className="automation-executor-grid" disabled={!canManageRules}>
          <article className={`automation-executor-card ${settings.appeal.enabled ? "enabled" : ""}`}>
            <header>
              <span className="automation-executor-icon"><FileWarning size={18} /></span>
              <div><strong>自动申诉</strong><small>审核拒绝广告 · 定时扫描</small></div>
              <span className={`executor-status ${settings.appeal.enabled ? "active" : ""}`}>{settings.appeal.enabled ? "运行中" : "已关闭"}</span>
            </header>
            <div className="executor-actions">
              <label className="executor-switch"><span>启用执行器</span><input aria-label="启用自动申诉" checked={settings.appeal.enabled} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, enabled: event.target.checked } })} role="switch" type="checkbox" /></label>
              <button className="secondary-button" onClick={() => setEditing(editing === "appeal" ? null : "appeal")} type="button">{editing === "appeal" ? "收起规则" : "配置规则"}</button>
            </div>
            <p className="executor-rule-summary">审核拒绝 · 每日 {settings.appeal.scheduleHours.map(formatHour).join("、")} · 明确失败最多重试 {settings.appeal.retryLimit} 次</p>
            {editing === "appeal" && (
              <div className="executor-rule-editor">
                <label className="field"><span>申诉文本模板</span><textarea rows={4} value={settings.appeal.textTemplate} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, textTemplate: event.target.value } })} /></label>
                <div className="field"><span>每日执行时间（最多 6 个）</span><div className="executor-hour-options">{Array.from({ length: 24 }, (_, hour) => <label key={hour}><input checked={settings.appeal.scheduleHours.includes(hour)} onChange={() => toggleHour(hour)} type="checkbox" /> {formatHour(hour)}</label>)}</div></div>
                <label className="field"><span>明确失败重试次数</span><input min={0} max={3} type="number" value={settings.appeal.retryLimit} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, retryLimit: Number(event.target.value) } })} /></label>
                <p>可用变量：<code>{"{ad_name}"}</code> <code>{"{ad_id}"}</code> <code>{"{reject_reason}"}</code>。</p>
              </div>
            )}
          </article>

          <article className={`automation-executor-card ${settings.copy.autoCopyEnabled ? "enabled" : ""}`}>
            <header>
              <span className="automation-executor-icon"><Copy size={18} /></span>
              <div><strong>自动复制</strong><small>当天数据达标 · 同账户同系列扩组</small></div>
              <span className={`executor-status ${settings.copy.autoCopyEnabled ? "active" : ""}`}>{settings.copy.autoCopyEnabled ? "运行中" : "已关闭"}</span>
            </header>
            <div className="executor-actions">
              <label className="executor-switch"><span>启用执行器</span><input aria-label="启用自动复制" checked={settings.copy.autoCopyEnabled} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyEnabled: event.target.checked } })} role="switch" type="checkbox" /></label>
              <button className="secondary-button" onClick={() => setEditing(editing === "copy" ? null : "copy")} type="button">{editing === "copy" ? "收起规则" : "配置规则"}</button>
            </div>
            <p className="executor-rule-summary">当天转化 ≥ {settings.copy.autoCopyMinConversions}、CPA ≤ {settings.copy.autoCopyMaxCpa}、CPC ≤ {settings.copy.autoCopyMaxCpc} · 每次 {settings.copy.autoCopyCount} 组 · 12:00 停止新任务</p>
            {editing === "copy" && (
              <div className="executor-rule-editor two-column">
                <label className="field"><span>转化数 ≥</span><input min={0} step={1} type="number" value={settings.copy.autoCopyMinConversions} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyMinConversions: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                <label className="field"><span>CPA ≤</span><input min={0} step={0.01} type="number" value={settings.copy.autoCopyMaxCpa} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyMaxCpa: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                <label className="field"><span>CPC ≤</span><input min={0} step={0.01} type="number" value={settings.copy.autoCopyMaxCpc} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyMaxCpc: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                <label className="field"><span>复制数量（默认 2）</span><input max={10} min={1} type="number" value={settings.copy.autoCopyCount} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyCount: Math.max(1, Math.min(10, Number(event.target.value) || 2)) } })} /></label>
                <label className="field"><span>复制后预算（留空=同源）</span><input min={0} step={0.01} type="number" value={settings.copy.autoCopyBudget ?? ""} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyBudget: event.target.value === "" ? null : Math.max(0, Number(event.target.value)) } })} /></label>
                <label className="field"><span>复制后出价（留空=同源）</span><input min={0} step={0.01} type="number" value={settings.copy.autoCopyBid ?? ""} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyBid: event.target.value === "" ? null : Math.max(0, Number(event.target.value)) } })} /></label>
                <p>固定策略：只统计账户时区当天数据；立即投放；同一来源只触发一次（不是每天一次）；自动生成组不再作为复制来源；命名固定为「源名-投放日期-时间」；每账户每日最多创建 {settings.copy.autoCopyDailyAccountLimit} 组。</p>
              </div>
            )}
          </article>

          <article className={`automation-executor-card danger ${settings.deletion.enabled ? "enabled" : ""}`}>
            <header>
              <span className="automation-executor-icon"><Trash2 size={18} /></span>
              <div><strong>自动删除广告组</strong><small>已关闭对象 · 每日 06:00 静默执行</small></div>
              <span className={`executor-status ${settings.deletion.enabled ? "danger" : ""}`}>{settings.deletion.enabled ? "已开启" : "已关闭"}</span>
            </header>
            <div className="executor-actions">
              <label className="executor-switch"><span>启用执行器</span><input aria-label="启用自动删除广告组" checked={settings.deletion.enabled} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, enabled: event.target.checked, onlyDisabled: true } })} role="switch" type="checkbox" /></label>
              <button className="secondary-button" onClick={() => setEditing(editing === "deletion" ? null : "deletion")} type="button">{editing === "deletion" ? "收起规则" : "配置规则"}</button>
            </div>
            <p className="executor-rule-summary">转化 ≤ {settings.deletion.maxConversions}、加购 ≤ {settings.deletion.maxCarts}{settings.deletion.maxConversions > 0 ? `、有转化时 CPA ≥ ${settings.deletion.minCpa}` : ""} · 每系列至少保留 1 组</p>
            {editing === "deletion" && (
              <div className="executor-rule-editor two-column">
                <label className="field"><span>转化数 ≤</span><input min={0} step={1} type="number" value={settings.deletion.maxConversions} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, maxConversions: Math.max(0, Number(event.target.value) || 0) } })} /><small>填 0 时只处理零转化广告组。</small></label>
                <label className="field"><span>加购数 ≤</span><input min={0} step={1} type="number" value={settings.deletion.maxCarts} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, maxCarts: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                <label className="field"><span>CPA ≥（仅有转化时）</span><input min={0} step={0.01} type="number" value={settings.deletion.minCpa} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, minCpa: Math.max(0, Number(event.target.value) || 0) } })} /></label>
                <label className="field"><span>关闭后保护时间（小时）</span><input min={1} max={720} type="number" value={settings.deletion.gracePeriodHours} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, gracePeriodHours: Number(event.target.value) } })} /></label>
                <div className="executor-safety-list"><span>只删除软件已确认关闭、最新同步仍为关闭的广告组</span><span>每天账户当地时间 06:00 扫描一次，静默运行并保留操作记录</span><span>每个系列至少保留一个组；结果未知后禁止自动重试</span></div>
                <p className="danger-copy">删除不可恢复。启用前请确认阈值适合账户币种和投放策略。</p>
              </div>
            )}
          </article>
        </fieldset>
      </form>
    </details>
  );
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "自动化执行器配置读取失败。";
}
