import { ChevronDown, ChevronUp, Clock3, Gauge, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  automationRuleDefinitions,
  type AutomationRuleDefinition,
  type GlobalAutomationSettings,
  type RuleConfiguration,
  type RuleConfigurationInput,
  type SyncEntityType,
} from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import { adjustRuleValue, formatRuleValue, getRuleSliderMaximum } from "./rule-controls";
import "./ui/pages/automation-rules.css";

export function RulesPage({
  settings,
  onSettingsSaved,
  onError,
}: {
  settings: GlobalAutomationSettings;
  onSettingsSaved: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const auth = useAuth();
  const canManageRules = auth.status.permissions.includes("rules:manage");
  const [configuration, setConfiguration] = useState<RuleConfiguration | null>(null);
  const [persistedRules, setPersistedRules] = useState<RuleConfiguration["rules"]>([]);
  const [globalSettings, setGlobalSettings] = useState({
    pollingIntervalMinutes: settings.pollingIntervalMinutes,
    maxActionsPerRun: settings.maxActionsPerRun,
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const saveInFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api.getRuleConfiguration();
      setConfiguration(loaded);
      setPersistedRules(loaded.rules);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setGlobalSettings({
      pollingIntervalMinutes: settings.pollingIntervalMinutes,
      maxActionsPerRun: settings.maxActionsPerRun,
    });
  }, [settings]);

  const enabledRules = useMemo(
    () => configuration?.rules.filter((rule) => rule.enabled).length ?? 0,
    [configuration],
  );

  const updateLayer = (entityType: SyncEntityType, enabled: boolean) => {
    if (!configuration || !canManageRules) return;
    const key = entityType === "campaign" ? "campaign" : entityType === "ad-group" ? "adGroup" : "ad";
    setConfiguration({
      ...configuration,
      layers: { ...configuration.layers, [key]: enabled },
    });
  };

  const updateRuleEnabled = (code: string, enabled: boolean) => {
    if (!configuration || !canManageRules) return;
    setConfiguration({
      ...configuration,
      rules: configuration.rules.map((rule) =>
        rule.code === code ? { ...rule, enabled } : rule,
      ),
    });
  };

  const updateRuleValue = (code: string, key: string, value: number) => {
    if (!configuration || !canManageRules) return;
    setConfiguration({
      ...configuration,
      rules: configuration.rules.map((rule) =>
        rule.code === code
          ? { ...rule, values: { ...rule.values, [key]: value } }
          : rule,
      ),
    });
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManageRules || !configuration || persistedRules.length === 0 || saveInFlight.current) return;
    try {
      saveInFlight.current = true;
      setSavingSettings(true);
      await api.updateGlobalAutomationSettings(globalSettings);
      const saved = await api.updateRuleConfiguration({
        layers: configuration.layers,
        rules: persistedRules,
      });
      setConfiguration({ ...configuration, updatedAt: saved.updatedAt });
      await onSettingsSaved();
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      saveInFlight.current = false;
      setSavingSettings(false);
    }
  };

  const saveRules = async () => {
    if (!configuration || !canManageRules || saveInFlight.current) return;
    try {
      saveInFlight.current = true;
      setSavingRules(true);
      const ruleInput: RuleConfigurationInput = {
        layers: configuration.layers,
        rules: configuration.rules,
      };
      const saved = await api.updateRuleConfiguration(ruleInput);
      setConfiguration(saved);
      setPersistedRules(saved.rules);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      saveInFlight.current = false;
      setSavingRules(false);
    }
  };

  if (!configuration) {
    return (
      <div className="empty-state">
        <div className="loader" />
        <span>正在读取规则配置…</span>
      </div>
    );
  }

  return (
    <section className="page-stack rules-page rules-workspace">
      <header className="rules-status-band">
        <div>
          <span className="rules-status-icon"><Gauge size={20} /></span>
          <div><h1>规则配置</h1><p>九条全局规则按固定优先级顺序执行，阈值与应用层级可在当前页面维护。</p></div>
        </div>
        <dl>
          <div><dt>规则状态</dt><dd>{enabledRules}/9 已启用</dd></div>
          <div><dt>权限</dt><dd>{canManageRules ? "可编辑" : "仅查看"}</dd></div>
          <div><dt>最近保存</dt><dd>{new Date(configuration.updatedAt).toLocaleString()}</dd></div>
        </dl>
      </header>

      <div className="rules-notice-stack">
        <div className="alert warning-alert"><Gauge size={18} /><span>币种提醒：九条规则当前为全账户共用阈值。不同币种账户会以各自账户币种直接比较，金额阈值可能不具可比性；请先只对同币种账户开启自动化。</span></div>
        {!canManageRules && <div className="alert warning-alert"><Gauge size={18} /><span>当前角色仅可查看规则配置；保存和启停需要 rules:manage 权限。</span></div>}
      </div>

      <form className="rule-settings-panel rules-runtime-section" onSubmit={(event) => void saveSettings(event)}>
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><RefreshCcw size={18} /></span>
            <div>
              <h2>全局运行设置</h2>
              <p>检测频率、单轮处理量和应用层级直接在这里调整。</p>
            </div>
          </div>
          <button className="primary-button" disabled={savingSettings || savingRules || !canManageRules} type="submit">
            <Save size={17} /> {savingSettings ? "保存中…" : "保存全局与层级"}
          </button>
        </div>
        <div className="rule-settings-body">
          <div className="rule-runtime-primary">
            <div className="rule-settings-sentence">
              每
              <InlineStepper
                disabled={!canManageRules}
                label="轮询间隔"
                maximum={1440}
                minimum={1}
                onChange={(pollingIntervalMinutes) => setGlobalSettings({ ...globalSettings, pollingIntervalMinutes })}
                step={1}
                value={globalSettings.pollingIntervalMinutes}
              />
              分钟检测一次，单轮最多处理
              <InlineStepper
                disabled={!canManageRules}
                label="单轮最多处理对象"
                maximum={100}
                minimum={1}
                onChange={(maxActionsPerRun) => setGlobalSettings({ ...globalSettings, maxActionsPerRun })}
                step={5}
                value={globalSettings.maxActionsPerRun}
              />
              个对象。
            </div>
            <div className="rule-window-lock">
              <Clock3 size={18} />
              <div>
                <strong>只处理最近 {configuration.lookbackHours} 小时创建的推广系列</strong>
                <span>固定保护范围，不提供修改，避免历史计划过多造成程序不稳定。</span>
              </div>
            </div>
          </div>
          <div className="rule-layer-grid">
            <LayerToggle label="推广系列" note="默认关闭" checked={configuration.layers.campaign} disabled={!canManageRules} onChange={(checked) => updateLayer("campaign", checked)} />
            <LayerToggle label="广告组" note="使用九条规则" checked={configuration.layers.adGroup} disabled={!canManageRules} onChange={(checked) => updateLayer("ad-group", checked)} />
            <LayerToggle label="广告" note="使用九条规则" checked={configuration.layers.ad} disabled={!canManageRules} onChange={(checked) => updateLayer("ad", checked)} />
          </div>
        </div>
      </form>

      <section className="rule-panel rules-matrix-section">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Gauge size={18} /></span>
            <div>
              <h2>九条固定规则</h2>
              <p>拖动滑块设定阈值，次数用加减按钮调整；九条规则的动作和保存逻辑保持不变。</p>
            </div>
          </div>
          <div className="row-actions">
            <span className="status active">已启用 {enabledRules}/9</span>
            <button
              className="primary-button"
              disabled={savingRules || savingSettings || !canManageRules}
              onClick={() => void saveRules()}
              type="button"
            >
              <Save size={17} /> {savingRules ? "保存中…" : "保存规则配置"}
            </button>
          </div>
        </div>
        <div className="rule-table-head" aria-hidden="true">
          <span>规则与状态</span><span>触发条件与阈值</span><span>执行动作</span>
        </div>
        <div className="rule-card-grid">
          {automationRuleDefinitions.map((definition, index) => {
            const rule = configuration.rules.find((item) => item.code === definition.code);
            if (!rule) return null;
            return (
              <article className={rule.enabled ? "rule-card rule-row" : "rule-card rule-row disabled"} key={definition.code}>
                <header>
                  <div className="rule-title">
                    <span className="rule-number">{index + 1}</span>
                    <div>
                      <strong>{definition.label}</strong>
                      <span>优先级 {definition.priority} · {definition.action === "enable" ? "开启" : "关闭"}</span>
                    </div>
                  </div>
                  <Toggle
                    checked={rule.enabled}
                    disabled={!canManageRules}
                    label={`${definition.label}${rule.enabled ? "已启用" : "已停用"}`}
                    onChange={(checked) => updateRuleEnabled(definition.code, checked)}
                  />
                </header>
                <RuleControls
                  definition={definition}
                  disabled={!canManageRules}
                  onChange={(key, value) => updateRuleValue(definition.code, key, value)}
                  values={rule.values}
                />
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function RuleControls({
  definition,
  values,
  disabled,
  onChange,
}: {
  definition: AutomationRuleDefinition;
  values: Record<string, number>;
  disabled: boolean;
  onChange: (key: string, value: number) => void;
}) {
  const countParameters = definition.parameters.filter((parameter) => parameter.step >= 1);
  const thresholdParameters = definition.parameters.filter((parameter) => parameter.step < 1);

  return (
    <div className="rule-controls">
      <div className="rule-condition-cell">
        <div className="rule-sentence">
          <span>{definition.description}</span>
          {countParameters.map((parameter) => (
            <span className="rule-inline-value" key={parameter.key}>
              <span>{parameter.label}</span>
              <InlineStepper
                disabled={disabled}
                label={parameter.label}
                minimum={0}
                onChange={(value) => onChange(parameter.key, value)}
                step={parameter.step}
                value={values[parameter.key] ?? 0}
              />
              <small>{parameter.unit}</small>
            </span>
          ))}
        </div>
        <div className="rule-threshold-list">
          {thresholdParameters.map((parameter) => (
            <RuleThreshold
              definitionLabel={definition.label}
              disabled={disabled}
              key={parameter.key}
              parameter={parameter}
              value={values[parameter.key] ?? 0}
              onChange={(value) => onChange(parameter.key, value)}
            />
          ))}
        </div>
      </div>
      <span className={definition.action === "enable" ? "rule-action-badge rule-action-cell enable" : "rule-action-badge rule-action-cell disable"}>
        {definition.action === "enable" ? "自动开启" : "自动关闭"}
      </span>
    </div>
  );
}

function RuleThreshold({
  definitionLabel,
  parameter,
  value,
  disabled,
  onChange,
}: {
  definitionLabel: string;
  parameter: AutomationRuleDefinition["parameters"][number];
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const interactionStep = 0.1;
  const [maximum, setMaximum] = useState(() => getRuleSliderMaximum(parameter.key, value));

  useEffect(() => {
    setMaximum((current) => Math.max(current, getRuleSliderMaximum(parameter.key, value)));
  }, [parameter.key, value]);

  return (
    <label className="rule-threshold">
      <span className="rule-threshold-head">
        <span>{parameter.label}</span>
        <strong>{formatRuleValue(value, parameter.step)}</strong>
      </span>
      <span className="rule-range-control">
        <button
          aria-label={`下调${definitionLabel} ${parameter.label}`}
          disabled={disabled || value <= 0}
          onClick={() => onChange(adjustRuleValue(value, interactionStep, -1, 0, maximum))}
          title="下调 0.1"
          type="button"
        ><ChevronDown size={14} /></button>
        <input
          aria-label={`${definitionLabel} ${parameter.label}`}
          className="rule-range"
          disabled={disabled}
          max={maximum}
          min="0"
          onChange={(event) => onChange(Number(Number(event.target.value).toFixed(1)))}
          step={interactionStep}
          type="range"
          value={value}
        />
        <button
          aria-label={`上调${definitionLabel} ${parameter.label}`}
          disabled={disabled || value >= maximum}
          onClick={() => onChange(adjustRuleValue(value, interactionStep, 1, 0, maximum))}
          title="上调 0.1"
          type="button"
        ><ChevronUp size={14} /></button>
      </span>
      <span className="rule-range-scale"><span>0</span><span>安全 ↔ 超限</span><span>{formatRuleValue(maximum, parameter.step)}</span></span>
    </label>
  );
}

function InlineStepper({
  value,
  step,
  minimum,
  maximum = Number.POSITIVE_INFINITY,
  disabled,
  label,
  onChange,
}: {
  value: number;
  step: number;
  minimum: number;
  maximum?: number;
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <span className="rule-stepper" role="group" aria-label={label}>
      <button
        aria-label={`减少${label}`}
        disabled={disabled || value <= minimum}
        onClick={() => onChange(adjustRuleValue(value, step, -1, minimum, maximum))}
        type="button"
      >−</button>
      <strong>{formatRuleValue(value, step)}</strong>
      <button
        aria-label={`增加${label}`}
        disabled={disabled || value >= maximum}
        onClick={() => onChange(adjustRuleValue(value, step, 1, minimum, maximum))}
        type="button"
      >+</button>
    </span>
  );
}

function LayerToggle({
  label,
  note,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rule-layer-item">
      <div>
        <strong>{label}</strong>
        <span>{note}</span>
      </div>
      <Toggle checked={checked} disabled={disabled} label={`${label}${checked ? "已启用" : "已停用"}`} onChange={onChange} />
    </div>
  );
}

function Toggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={checked ? "toggle checked" : "toggle"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <span />
    </button>
  );
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
}
