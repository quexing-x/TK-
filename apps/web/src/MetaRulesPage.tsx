import {
  Activity,
  CircleAlert,
  Gauge,
  Pause,
  Play,
  Save,
  ShieldCheck,
} from "./ui/icons";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  metaAutomationRuleDefinitions,
  type AccountConfig,
  type MetaAutomationRuleCode,
  type MetaAutomationRuntime,
  type MetaRuleConfiguration,
  type MetaRuleLayerSettings,
} from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import { useOverlays } from "./ui/overlays";
import "./ui/pages/meta-rules.css";

export function MetaRulesPage({
  accounts,
  onError,
}: {
  accounts: AccountConfig[];
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const { confirm, toast } = useOverlays();
  const canManageRules = auth.status.permissions.includes("rules:manage");
  const canControlRuntime = auth.status.permissions.includes("system:control");
  const [configuration, setConfiguration] = useState<MetaRuleConfiguration | null>(null);
  const [runtime, setRuntime] = useState<MetaAutomationRuntime | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextConfiguration, nextRuntime] = await Promise.all([
        api.getMetaRuleConfiguration(),
        api.getMetaAutomationRuntime(),
      ]);
      setConfiguration(nextConfiguration);
      setRuntime(nextRuntime);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledRules = configuration?.rules.filter((item) => item.enabled).length ?? 0;
  const enabledMetaAccounts = useMemo(
    () => accounts.filter((account) =>
      account.providerKind === "meta-marketing-api" && account.enabled,
    ).length,
    [accounts],
  );

  const updateLayer = (key: keyof MetaRuleLayerSettings, enabled: boolean) => {
    if (!configuration || !canManageRules) return;
    setConfiguration({
      ...configuration,
      layers: { ...configuration.layers, [key]: enabled },
    });
  };

  const updateRuleEnabled = (code: MetaAutomationRuleCode, enabled: boolean) => {
    if (!configuration || !canManageRules) return;
    setConfiguration({
      ...configuration,
      rules: configuration.rules.map((rule) => rule.code === code
        ? { ...rule, enabled }
        : rule),
    });
  };

  const updateRuleValue = (code: MetaAutomationRuleCode, key: string, value: number) => {
    if (!configuration || !canManageRules || !Number.isFinite(value) || value < 0) return;
    setConfiguration({
      ...configuration,
      rules: configuration.rules.map((rule) => rule.code === code
        ? { ...rule, values: { ...rule.values, [key]: value } }
        : rule),
    });
  };

  const saveRules = async () => {
    if (!configuration || !canManageRules) return;
    try {
      setBusy("rules");
      const saved = await api.updateMetaRuleConfiguration({
        schemaVersion: configuration.schemaVersion,
        metricWindow: configuration.metricWindow,
        layers: configuration.layers,
        rules: configuration.rules,
      }, configuration.updatedAt);
      setConfiguration(saved);
      toast("Meta 三层规则配置已保存");
    } catch (cause) {
      onError(getErrorMessage(cause));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const saveRuntime = async (event: FormEvent) => {
    event.preventDefault();
    if (!runtime || !canControlRuntime) return;
    try {
      setBusy("runtime");
      const saved = await api.updateMetaAutomationRuntime({
        enabled: runtime.enabled,
        pollingIntervalMinutes: runtime.pollingIntervalMinutes,
        maxActionsPerRun: runtime.maxActionsPerRun,
      }, runtime.updatedAt);
      setRuntime(saved);
      toast("Meta 运行设置已保存");
    } catch (cause) {
      onError(getErrorMessage(cause));
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggleRuntime = async () => {
    if (!runtime || !canControlRuntime) return;
    const nextEnabled = !runtime.enabled;
    if (nextEnabled) {
      if (enabledMetaAccounts === 0) return;
      const approved = await confirm({
        title: "开启 Meta 自动化运行开关",
        message: `当前有 ${enabledMetaAccounts} 个 Meta Marketing API 账户已开启账户自动化。开启后，只有 liveMode=automation-status 且能力就绪的账户会进入轮询。`,
        confirmLabel: "确认开启",
        danger: true,
      });
      if (!approved) return;
    }
    try {
      setBusy("runtime-toggle");
      const saved = await api.updateMetaAutomationRuntime({
        enabled: nextEnabled,
        pollingIntervalMinutes: runtime.pollingIntervalMinutes,
        maxActionsPerRun: runtime.maxActionsPerRun,
      }, runtime.updatedAt);
      setRuntime(saved);
      toast(nextEnabled ? "Meta 自动化已开启" : "Meta 自动化已暂停");
    } catch (cause) {
      onError(getErrorMessage(cause));
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!configuration || !runtime) {
    return <section className="page-stack meta-rules-page"><div className="panel meta-rules-loading">正在读取本地 Meta 规则与运行设置…</div></section>;
  }

  return (
    <section className="page-stack meta-rules-page">
      <header className="meta-rules-status-band">
        <div><span className="meta-rules-status-icon"><Gauge size={20} /></span><div><span className="eyebrow">META AUTOMATION</span><h2>Meta 三层自动化规则</h2><p>独立于 TikTok；指标窗口固定为账户时区当天，不共享配置或运行开关。</p></div></div>
        <dl>
          <div><dt>Schema</dt><dd>{configuration.schemaVersion}</dd></div>
          <div><dt>Metric Window</dt><dd>{configuration.metricWindow}</dd></div>
          <div><dt>规则</dt><dd>{enabledRules}/{configuration.rules.length} 已启用</dd></div>
          <div><dt>运行</dt><dd>{runtime.enabled ? "运行中" : "已暂停"}</dd></div>
        </dl>
      </header>

      <section className="panel meta-runtime-panel">
        <div className="panel-heading"><div><span className="panel-icon"><Activity size={18} /></span><div><h2>Meta 独立运行开关</h2><p>还需账户 enabled、liveMode=automation-status、连接能力与规则层级同时满足</p></div></div><button className={runtime.enabled ? "danger-button" : "primary-button"} disabled={!canControlRuntime || busy !== null || (!runtime.enabled && enabledMetaAccounts === 0)} onClick={() => void toggleRuntime()} type="button">{runtime.enabled ? <Pause size={16} /> : <Play size={16} />}{busy === "runtime-toggle" ? "保存中…" : runtime.enabled ? "暂停 Meta 自动化" : "开启 Meta 自动化"}</button></div>
        <form className="meta-runtime-form" onSubmit={(event) => void saveRuntime(event)}>
          <label className="field"><span>轮询间隔（分钟）</span><input min={1} max={60} type="number" value={runtime.pollingIntervalMinutes} onChange={(event) => setRuntime({ ...runtime, pollingIntervalMinutes: Number(event.target.value) })} /></label>
          <label className="field"><span>每轮最大动作</span><input min={1} max={100} type="number" value={runtime.maxActionsPerRun} onChange={(event) => setRuntime({ ...runtime, maxActionsPerRun: Number(event.target.value) })} /></label>
          <div className="meta-runtime-facts"><span><ShieldCheck size={15} />已开启 Meta 账户：{enabledMetaAccounts}</span><span><CircleAlert size={15} />unknown 禁止自动重放</span></div>
          <button className="secondary-button" disabled={!canControlRuntime || busy !== null} type="submit"><Save size={16} />{busy === "runtime" ? "保存中…" : "保存运行参数"}</button>
        </form>
      </section>

      <section className="panel meta-layer-panel">
        <div className="panel-heading"><div><span className="panel-icon"><ShieldCheck size={18} /></span><div><h2>参与自动化的对象层级</h2><p>三层均独立关闭；保存规则不会自动打开层级或运行开关</p></div></div></div>
        <div className="meta-layer-grid">
          <LayerToggle label="广告系列" note="系列层配置状态" checked={configuration.layers.campaign} disabled={!canManageRules} onChange={(checked) => updateLayer("campaign", checked)} />
          <LayerToggle label="广告组" note="广告组层配置状态" checked={configuration.layers.adGroup} disabled={!canManageRules} onChange={(checked) => updateLayer("adGroup", checked)} />
          <LayerToggle label="广告" note="广告层配置状态" checked={configuration.layers.ad} disabled={!canManageRules} onChange={(checked) => updateLayer("ad", checked)} />
        </div>
      </section>

      <section className="panel meta-rule-matrix">
        <div className="panel-heading"><div><span className="panel-icon"><Gauge size={18} /></span><div><h2>Meta 规则矩阵</h2><p>九条规则独立存储；阈值只作用于 Meta account-today 指标</p></div></div><button className="primary-button" disabled={!canManageRules || busy !== null} onClick={() => void saveRules()} type="button"><Save size={16} />{busy === "rules" ? "保存中…" : "保存 Meta 规则"}</button></div>
        <div className="meta-rule-list">
          {metaAutomationRuleDefinitions.map((definition, index) => {
            const rule = configuration.rules.find((item) => item.code === definition.code);
            if (!rule) return null;
            return <article className={rule.enabled ? "meta-rule-row enabled" : "meta-rule-row"} key={definition.code}>
              <header><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{definition.label}</strong><small>{definition.description}</small></div><label className="meta-rule-toggle"><input checked={rule.enabled} disabled={!canManageRules} onChange={(event) => updateRuleEnabled(definition.code, event.target.checked)} type="checkbox" /><i /></label></header>
              <div className="meta-rule-parameters">{definition.parameters.map((parameter) => <label className="field" key={parameter.key}><span>{parameter.label}</span><div><input min={0} step={parameter.step} type="number" value={rule.values[parameter.key] ?? 0} onChange={(event) => updateRuleValue(definition.code, parameter.key, Number(event.target.value))} /><small>{parameter.unit}</small></div></label>)}</div>
              <span className={definition.action === "enable" ? "meta-rule-action enable" : "meta-rule-action disable"}>{definition.action === "enable" ? "开启" : "暂停"}</span>
            </article>;
          })}
        </div>
      </section>

      {!canManageRules && <div className="alert warning-alert"><CircleAlert size={18} /><span>当前角色仅可查看 Meta 规则；编辑需要 rules:manage 权限。</span></div>}
    </section>
  );
}

function LayerToggle({
  label,
  note,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <label className={checked ? "meta-layer-card enabled" : "meta-layer-card"}><span><strong>{label}</strong><small>{note}</small></span><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /></label>;
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Meta 规则页面发生未知错误。";
}
