import { type FormEvent, useEffect, useState } from "react";
import { Copy, FileWarning, Save, Trash2 } from "lucide-react";
import type { AutomationFeatureSettingsInput } from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";

export function AutomationFeaturesPage({ onError }: { onError: (message: string | null) => void }) {
  const auth = useAuth();
  const canManageRules = auth.status.permissions.includes("rules:manage");
  const [settings, setSettings] = useState<AutomationFeatureSettingsInput | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getAutomationFeatures().then((value) => setSettings(value)).catch((cause) => onError(messageOf(cause)));
  }, [onError]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || !canManageRules) return;
    try {
      setSaving(true);
      setSettings(await api.updateAutomationFeatures(settings));
      onError(null);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return null;
  return (
    <details className="panel feature-config">
      <summary>预留自动化配置（尚未接入执行器）</summary>
    <form onSubmit={(event) => void save(event)}>
      <div className="panel-heading"><div><span className="panel-icon"><FileWarning size={18} /></span><div><h2>扩展自动化</h2><p>当前仅保存草稿，不会触发申诉、复制或删除；接入执行器前不会自动生效。</p></div></div><button className="primary-button" disabled={saving || !canManageRules} type="submit"><Save size={16} /> {saving ? "保存中…" : "保存草稿"}</button></div>
      {!canManageRules && <div className="alert warning-alert">当前角色仅可查看预留配置；保存草稿需要 rules:manage 权限。</div>}
      <fieldset className="feature-card-grid" disabled={!canManageRules}>
        <article className="feature-card"><header><span><FileWarning size={18} /></span><div><strong>自动申诉</strong><small>配置已完成 · 执行器待接入</small></div></header><label className="field"><span>申诉文本模板</span><textarea rows={5} value={settings.appeal.textTemplate} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, textTemplate: event.target.value } })} /></label><label className="field"><span>失败重试次数</span><input min={0} max={3} type="number" value={settings.appeal.retryLimit} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, retryLimit: Number(event.target.value) } })} /></label><p>可用变量：<code>{"{ad_name}"}</code> <code>{"{ad_id}"}</code> <code>{"{reject_reason}"}</code></p></article>
        <article className="feature-card"><header><span><Copy size={18} /></span><div><strong>复制广告</strong><small>规则已完成 · 执行器待接入</small></div></header><label className="field"><span>命名规则</span><input value={settings.copy.namingTemplate} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, namingTemplate: event.target.value } })} /></label><label className="check-row"><input checked={settings.copy.startPaused} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, startPaused: event.target.checked } })} type="checkbox" /> 新广告默认关闭</label><label className="check-row"><input checked={settings.copy.copyBudget} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, copyBudget: event.target.checked } })} type="checkbox" /> 同步复制预算</label><p>可用变量：<code>{"{source_name}"}</code> <code>{"{account_name}"}</code> <code>{"{date}"}</code></p></article>
        <article className="feature-card danger"><header><span><Trash2 size={18} /></span><div><strong>删除广告</strong><small>保护规则已完成 · 执行器待接入</small></div></header><label className="check-row"><input checked={settings.deletion.onlyDisabled} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, onlyDisabled: event.target.checked } })} type="checkbox" /> 只允许删除已关闭对象</label><label className="field"><span>关闭后保护时间（小时）</span><input min={1} max={720} type="number" value={settings.deletion.gracePeriodHours} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, gracePeriodHours: Number(event.target.value) } })} /></label><p>删除属于不可逆操作。真实执行前还会增加二次确认、审计和 Provider 权限检查。</p></article>
      </fieldset>
    </form>
    </details>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "扩展自动化配置读取失败。";
}
