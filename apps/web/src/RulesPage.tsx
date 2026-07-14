import { Clock3, Gauge, Layers3, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  automationRuleDefinitions,
  type GlobalAutomationSettings,
  type RuleConfiguration,
  type RuleConfigurationInput,
  type SyncEntityType,
} from "@tk-auto/core";
import { api } from "./api";

export function RulesPage({
  settings,
  onSettingsSaved,
  onError,
}: {
  settings: GlobalAutomationSettings;
  onSettingsSaved: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [configuration, setConfiguration] = useState<RuleConfiguration | null>(null);
  const [globalSettings, setGlobalSettings] = useState({
    pollingIntervalMinutes: settings.pollingIntervalMinutes,
    maxActionsPerRun: settings.maxActionsPerRun,
  });
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  const load = useCallback(async () => {
    try {
      setConfiguration(await api.getRuleConfiguration());
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
    if (!configuration) return;
    const key = entityType === "campaign" ? "campaign" : entityType === "ad-group" ? "adGroup" : "ad";
    setConfiguration({
      ...configuration,
      layers: { ...configuration.layers, [key]: enabled },
    });
  };

  const updateRuleEnabled = (code: string, enabled: boolean) => {
    if (!configuration) return;
    setConfiguration({
      ...configuration,
      rules: configuration.rules.map((rule) =>
        rule.code === code ? { ...rule, enabled } : rule,
      ),
    });
  };

  const updateRuleValue = (code: string, key: string, value: number) => {
    if (!configuration) return;
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
    try {
      setSavingSettings(true);
      await api.updateGlobalAutomationSettings(globalSettings);
      await onSettingsSaved();
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setSavingSettings(false);
    }
  };

  const saveRules = async () => {
    if (!configuration) return;
    try {
      setSavingRules(true);
      const ruleInput: RuleConfigurationInput = {
        layers: configuration.layers,
        rules: configuration.rules,
      };
      const saved = await api.updateRuleConfiguration(ruleInput);
      setConfiguration(saved);
      onError(null);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
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
    <section className="page-stack">
      <form className="panel form-panel" onSubmit={(event) => void saveSettings(event)}>
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><RefreshCcw size={18} /></span>
            <div>
              <h2>全局运行设置</h2>
              <p>以下设置和九条规则对所有已接入账户统一生效。</p>
            </div>
          </div>
          <button className="primary-button" disabled={savingSettings} type="submit">
            <Save size={17} /> {savingSettings ? "保存中…" : "保存运行设置"}
          </button>
        </div>
        <div className="rule-runtime-grid">
          <label className="field">
            <span>轮询间隔（分钟）</span>
            <input
              min="1"
              max="1440"
              type="number"
              value={globalSettings.pollingIntervalMinutes}
              onChange={(event) => setGlobalSettings({
                ...globalSettings,
                pollingIntervalMinutes: Number(event.target.value),
              })}
            />
          </label>
          <label className="field">
            <span>单轮最多启停</span>
            <input
              min="1"
              max="100"
              type="number"
              value={globalSettings.maxActionsPerRun}
              onChange={(event) => setGlobalSettings({
                ...globalSettings,
                maxActionsPerRun: Number(event.target.value),
              })}
            />
          </label>
          <div className="rule-window-lock">
            <Clock3 size={18} />
            <div>
              <strong>只处理最近 {configuration.lookbackHours} 小时创建的推广系列</strong>
              <span>固定保护范围，不提供修改，避免历史计划过多造成程序不稳定。</span>
            </div>
          </div>
        </div>
      </form>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Layers3 size={18} /></span>
            <div>
              <h2>规则应用层级</h2>
              <p>三个层级共用同一套规则；推广系列默认不应用。</p>
            </div>
          </div>
        </div>
        <div className="rule-layer-grid">
          <LayerToggle
            label="推广系列"
            note="默认关闭"
            checked={configuration.layers.campaign}
            onChange={(checked) => updateLayer("campaign", checked)}
          />
          <LayerToggle
            label="广告组"
            note="使用九条规则"
            checked={configuration.layers.adGroup}
            onChange={(checked) => updateLayer("ad-group", checked)}
          />
          <LayerToggle
            label="广告"
            note="使用九条规则"
            checked={configuration.layers.ad}
            onChange={(checked) => updateLayer("ad", checked)}
          />
        </div>
      </section>

      <section className="panel rule-panel">
        <div className="panel-heading">
          <div>
            <span className="panel-icon"><Gauge size={18} /></span>
            <div>
              <h2>九条固定规则</h2>
              <p>规则结构、优先级和动作已锁定；红色数值可以修改。开启规则命中时，也会重新开启手动关闭的对象。</p>
            </div>
          </div>
          <div className="row-actions">
            <span className="status active">已启用 {enabledRules}/9</span>
            <button
              className="primary-button"
              disabled={savingRules}
              onClick={() => void saveRules()}
              type="button"
            >
              <Save size={17} /> {savingRules ? "保存中…" : "保存规则配置"}
            </button>
          </div>
        </div>
        <div className="rule-card-grid">
          {automationRuleDefinitions.map((definition, index) => {
            const rule = configuration.rules.find((item) => item.code === definition.code);
            if (!rule) return null;
            return (
              <article className={rule.enabled ? "rule-card" : "rule-card disabled"} key={definition.code}>
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
                    label={`${definition.label}${rule.enabled ? "已启用" : "已停用"}`}
                    onChange={(checked) => updateRuleEnabled(definition.code, checked)}
                  />
                </header>
                <p>{definition.description}</p>
                <div className="rule-values">
                  {definition.parameters.map((parameter) => (
                    <label key={parameter.key}>
                      <span>{parameter.label}</span>
                      <div>
                        <input
                          className="editable-rule-value"
                          min="0"
                          step={parameter.step}
                          type="number"
                          value={rule.values[parameter.key] ?? 0}
                          onChange={(event) => updateRuleValue(
                            definition.code,
                            parameter.key,
                            Number(event.target.value),
                          )}
                        />
                        <small>{parameter.unit}</small>
                      </div>
                    </label>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function LayerToggle({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rule-layer-item">
      <div>
        <strong>{label}</strong>
        <span>{note}</span>
      </div>
      <Toggle checked={checked} label={`${label}${checked ? "已启用" : "已停用"}`} onChange={onChange} />
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={checked ? "toggle checked" : "toggle"}
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
