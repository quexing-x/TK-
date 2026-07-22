import { type FormEvent, useEffect, useState } from "react";
import { Copy, FileWarning, Save, Settings2, Trash2 } from "lucide-react";
import type { AutomationFeatureSettingsInput } from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import "./ui/pages/automation-rules.css";

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

  if (!settings) {
    return (
      <div className="automation-extension-loading" aria-live="polite">
        <span className="loader" />
        <span>正在读取扩展自动化配置…</span>
      </div>
    );
  }

  return (
    <details className="automation-extension-section feature-config">
      <summary>
        <span className="automation-extension-summary-icon"><Settings2 size={17} /></span>
        <span>
          <strong>扩展自动化配置</strong>
          <small>草稿能力，尚未接入执行器</small>
        </span>
        <span className="automation-extension-state">3 项配置</span>
      </summary>
      <form onSubmit={(event) => void save(event)}>
        <div className="automation-extension-toolbar">
          <div>
            <h2>扩展自动化</h2>
            <p>当前仅保存草稿，不会触发申诉、复制或删除；接入执行器前不会自动生效。</p>
          </div>
          <button className="primary-button" disabled={saving || !canManageRules} type="submit"><Save size={16} /> {saving ? "保存中…" : "保存草稿"}</button>
        </div>
        {!canManageRules && <div className="alert warning-alert">当前角色仅可查看预留配置；保存草稿需要 rules:manage 权限。</div>}
        <fieldset className="automation-extension-grid" disabled={!canManageRules}>
          <article className="automation-feature-row">
            <header><span><FileWarning size={18} /></span><div><strong>自动申诉</strong><small>配置已完成，执行器待接入</small></div></header>
            <div className="automation-feature-fields appeal-fields">
              <label className="field"><span>申诉文本模板</span><textarea rows={4} value={settings.appeal.textTemplate} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, textTemplate: event.target.value } })} /></label>
              <label className="field"><span>失败重试次数</span><input min={0} max={3} type="number" value={settings.appeal.retryLimit} onChange={(event) => setSettings({ ...settings, appeal: { ...settings.appeal, retryLimit: Number(event.target.value) } })} /></label>
            </div>
            <p>可用变量：<code>{"{ad_name}"}</code> <code>{"{ad_id}"}</code> <code>{"{reject_reason}"}</code></p>
          </article>
          <article className="automation-feature-row">
            <header><span><Copy size={18} /></span><div><strong>复制广告</strong><small>规则已完成，执行器待接入</small></div></header>
            <div className="automation-feature-fields">
              <label className="field"><span>命名规则</span><input value={settings.copy.namingTemplate} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, namingTemplate: event.target.value } })} /></label>
              <div className="automation-checks"><label className="check-row"><input checked={settings.copy.startPaused} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, startPaused: event.target.checked } })} type="checkbox" /> 新广告默认关闭</label><label className="check-row"><input checked={settings.copy.copyBudget} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, copyBudget: event.target.checked } })} type="checkbox" /> 同步复制预算</label></div>
            </div>
            <p>可用变量：<code>{"{source_name}"}</code> <code>{"{account_name}"}</code> <code>{"{date}"}</code></p>
            <div className="autocopy-block">
              <label className="autocopy-toggle">
                <span><strong>广告组自动复制（独立账户）</strong><small>命中规则时在同账户自动复制 N 个广告组；预算/出价默认同源，立刻投放，同账户默认同系列。</small></span>
                <input aria-label="启用广告组自动复制" checked={settings.copy.autoCopyEnabled} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyEnabled: event.target.checked } })} role="switch" type="checkbox" />
              </label>
              {settings.copy.autoCopyEnabled && (
                <div className="autocopy-fields">
                  <label className="field"><span>触发规则</span>
                    <select value={settings.copy.autoCopyTriggerRuleCode} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyTriggerRuleCode: event.target.value } })}>
                      <option value="">任意关闭规则命中时</option>
                      <option value="NO_CONV_SPEND_CLOSE">零转化消耗过高</option>
                      <option value="NO_CONV_CPC_CLOSE">零转化 CPC 过高</option>
                      <option value="CV1_CPC_CLOSE">单次转化 CPC 过高</option>
                      <option value="CV1_CPA_CLOSE">单次转化 CPA 过高</option>
                      <option value="CV2_CPA_CLOSE">多次转化 CPA 过高</option>
                      <option value="NO_CART_CLOSE">有消耗无加购</option>
                    </select>
                  </label>
                  <label className="field"><span>复制数量（1–10）</span><input max={10} min={1} type="number" value={settings.copy.autoCopyCount} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyCount: Math.max(1, Math.min(10, Number(event.target.value) || 1)) } })} /></label>
                  <label className="field"><span>广告组日预算（留空=同源）</span><input min={0} step={0.01} type="number" value={settings.copy.autoCopyBudget ?? ""} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyBudget: event.target.value === "" ? null : Math.max(0, Number(event.target.value)) } })} /></label>
                  <label className="field"><span>出价（留空=同源）</span><input min={0} step={0.01} type="number" value={settings.copy.autoCopyBid ?? ""} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyBid: event.target.value === "" ? null : Math.max(0, Number(event.target.value)) } })} /></label>
                  <div className="automation-checks"><label className="check-row"><input checked={settings.copy.autoCopyLaunchImmediately} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopyLaunchImmediately: event.target.checked } })} type="checkbox" /> 立刻投放</label><label className="check-row"><input checked={settings.copy.autoCopySameCampaign} onChange={(event) => setSettings({ ...settings, copy: { ...settings.copy, autoCopySameCampaign: event.target.checked } })} type="checkbox" /> 同账户同系列</label></div>
                </div>
              )}
            </div>
          </article>
          <article className="automation-feature-row danger">
            <header><span><Trash2 size={18} /></span><div><strong>删除广告</strong><small>保护规则已完成，执行器待接入</small></div></header>
            <div className="automation-feature-fields">
              <label className="field"><span>关闭后保护时间（小时）</span><input min={1} max={720} type="number" value={settings.deletion.gracePeriodHours} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, gracePeriodHours: Number(event.target.value) } })} /></label>
              <div className="automation-checks"><label className="check-row"><input checked={settings.deletion.onlyDisabled} onChange={(event) => setSettings({ ...settings, deletion: { ...settings.deletion, onlyDisabled: event.target.checked } })} type="checkbox" /> 只允许删除已关闭对象</label></div>
            </div>
            <p>删除属于不可逆操作。真实执行前还会增加二次确认、审计和 Provider 权限检查。</p>
          </article>
        </fieldset>
      </form>
    </details>
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "扩展自动化配置读取失败。";
}
