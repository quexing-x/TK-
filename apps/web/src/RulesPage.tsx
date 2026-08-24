import { ChevronDown, ChevronUp, Clock3, Gauge, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  applyGroupEnabled,
  applyGroupValue,
  automationRuleGroups,
  isGroupEnabled,
  isGroupMixed,
  minimumGroupValue,
  readGroupValue,
  ruleValueCeiling,
  ungroupedRuleDefinitions,
  type AutomationRuleDefinition,
  type AutomationRuleGroup,
  type GlobalAutomationSettings,
  type RuleConfiguration,
  type RuleConfigurationInput,
  type SyncEntityType,
} from "@tk-auto/core";
import { api } from "./api";
import { useAuth } from "./AuthGate";
import {
  adjustRuleValue,
  formatRuleValue,
  getRuleSliderMaximum,
  resolveRuleSliderMaximum,
} from "./rule-controls";
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

  // 计数按界面上的卡片数来，跟用户看到的一致；底层仍然是九条。
  const ruleCardCount = automationRuleGroups.length + ungroupedRuleDefinitions.length;
  const enabledRules = useMemo(() => {
    if (!configuration) return 0;
    const groups = automationRuleGroups.filter((group) =>
      isGroupEnabled(group, configuration.rules),
    ).length;
    const singles = ungroupedRuleDefinitions.filter((definition) =>
      configuration.rules.find((rule) => rule.code === definition.code)?.enabled,
    ).length;
    return groups + singles;
  }, [configuration]);

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

  // 分组卡片改的仍然是底层那几条规则，只是一次写多条。存储结构没有变化。
  const updateGroupEnabled = (group: AutomationRuleGroup, enabled: boolean) => {
    if (!configuration || !canManageRules) return;
    setConfiguration({
      ...configuration,
      rules: applyGroupEnabled(group, enabled, configuration.rules),
    });
  };

  const updateGroupValue = (group: AutomationRuleGroup, key: string, value: number) => {
    if (!configuration || !canManageRules) return;
    setConfiguration({
      ...configuration,
      rules: applyGroupValue(group, key, value, configuration.rules),
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
          <div><dt>规则状态</dt><dd>{enabledRules}/{ruleCardCount} 已启用</dd></div>
          <div><dt>权限</dt><dd>{canManageRules ? "可编辑" : "仅查看"}</dd></div>
          <div><dt>最近保存</dt><dd>{new Date(configuration.updatedAt).toLocaleString()}</dd></div>
        </dl>
      </header>

      <div className="rules-notice-stack">
        <div className="alert warning-alert"><Gauge size={15} /><span>阈值为全账户共用；跨币种账户金额不可直接比较，建议只对同币种账户开启自动化。</span></div>
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
              <h2>固定规则</h2>
              <p>
                拖动滑块设定阈值，次数用加减按钮调整。同一指标的「超标关闭」与「达标恢复」
                合并成一条展示，改一次两个方向一起生效；判定逻辑与保存结果没有变化。
              </p>
            </div>
          </div>
          <div className="row-actions">
            <span className="status active">
              已启用 {enabledRules}/{ruleCardCount}
            </span>
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
        <RuleCards
          canManage={canManageRules}
          onChange={(rules) => setConfiguration({ ...configuration, rules })}
          rules={configuration.rules}
        />
      </section>
    </section>
  );
}

/**
 * 规则卡片列表：先是合并了「超标关闭 + 达标恢复」的分组卡，再是没有恢复方向、
 * 保持独立的单条规则卡。
 *
 * 从页面里拆出来是为了能脱离登录态单独渲染验证——这块的输入直接决定真实的广告
 * 启停，只靠类型检查过关是不够的。
 */
export function RuleCards({
  rules,
  canManage,
  onChange,
}: {
  rules: RuleConfiguration["rules"];
  canManage: boolean;
  onChange: (rules: RuleConfiguration["rules"]) => void;
}) {
  return (
    <div className="rule-card-grid">
      {automationRuleGroups.map((group, index) => {
        const enabled = isGroupEnabled(group, rules);
        const mixed = isGroupMixed(group, rules);
        return (
          <article className={enabled ? "rule-card rule-row" : "rule-card rule-row disabled"} key={group.key}>
            <header>
              <div className="rule-title">
                <span className="rule-number">{index + 1}</span>
                <div>
                  <strong>{group.label}</strong>
                  <span>优先级 {group.priority} · 关闭与恢复</span>
                </div>
              </div>
              <Toggle
                checked={enabled}
                disabled={!canManage}
                label={`${group.label}${enabled ? "已启用" : "已停用"}`}
                onChange={(checked) => onChange(applyGroupEnabled(group, checked, rules))}
              />
            </header>
            {mixed ? (
              // 存量配置里可能只开了一个方向。合并后一个开关表达不了这种状态，
              // 必须说出来——静默统一等于替用户改了规则。
              <p className="rule-mixed-note" role="status">
                这条规则的关闭与恢复方向当前开关状态不一致（旧版界面可以分开设置）。
                拨动上面的开关会把两个方向统一为同一状态。
              </p>
            ) : null}
            <RuleGroupControls
              disabled={!canManage}
              group={group}
              onChange={(key, value) => onChange(applyGroupValue(group, key, value, rules))}
              rules={rules}
            />
          </article>
        );
      })}
      {ungroupedRuleDefinitions.map((definition, index) => {
        const rule = rules.find((item) => item.code === definition.code);
        if (!rule) return null;
        return (
          <article className={rule.enabled ? "rule-card rule-row" : "rule-card rule-row disabled"} key={definition.code}>
            <header>
              <div className="rule-title">
                <span className="rule-number">{automationRuleGroups.length + index + 1}</span>
                <div>
                  <strong>{definition.label}</strong>
                  <span>优先级 {definition.priority} · {definition.action === "enable" ? "开启" : "关闭"}</span>
                </div>
              </div>
              <Toggle
                checked={rule.enabled}
                disabled={!canManage}
                label={`${definition.label}${rule.enabled ? "已启用" : "已停用"}`}
                onChange={(checked) => onChange(rules.map((item) =>
                  item.code === definition.code ? { ...item, enabled: checked } : item))}
              />
            </header>
            <RuleControls
              definition={definition}
              disabled={!canManage}
              onChange={(key, value) => onChange(rules.map((item) =>
                item.code === definition.code
                  ? { ...item, values: { ...item.values, [key]: value } }
                  : item))}
              rules={rules}
              values={rule.values}
            />
          </article>
        );
      })}
    </div>
  );
}

/**
 * 分组卡片的输入区。和 RuleControls 长得一样，区别只在于：一个输入框会写进
 * 分组覆盖的每一条底层规则，右侧的动作标签同时标出关闭与恢复两个方向。
 */
function RuleGroupControls({
  group,
  rules,
  disabled,
  onChange,
}: {
  group: AutomationRuleGroup;
  rules: RuleConfiguration["rules"];
  disabled: boolean;
  onChange: (key: string, value: number) => void;
}) {
  const countParameters = group.parameters.filter((parameter) => parameter.step >= 1);
  const thresholdParameters = group.parameters.filter((parameter) => parameter.step < 1);
  const valueOf = (key: string) => {
    const value = readGroupValue(group, key, rules);
    return Number.isFinite(value) ? value : 0;
  };

  return (
    <div className="rule-controls">
      <div className="rule-condition-cell">
        <div className="rule-sentence">
          <span>{group.description}</span>
          {countParameters.map((parameter) => (
            <span className="rule-inline-value" key={parameter.key}>
              <span>{parameter.label}</span>
              <InlineStepper
                disabled={disabled}
                label={parameter.label}
                minimum={minimumGroupValue(group, parameter.key)}
                onChange={(value) => onChange(parameter.key, value)}
                step={parameter.step}
                value={valueOf(parameter.key)}
              />
              <small>{parameter.unit}</small>
            </span>
          ))}
        </div>
        <div className="rule-threshold-list">
          {thresholdParameters.map((parameter) => (
            <RuleThreshold
              definitionLabel={group.label}
              disabled={disabled}
              key={parameter.key}
              parameter={parameter}
              value={valueOf(parameter.key)}
              onChange={(value) => onChange(parameter.key, value)}
            />
          ))}
        </div>
      </div>
      <span className="rule-action-cell rule-action-pair">
        <span className="rule-action-badge disable">超标关闭</span>
        <span className="rule-action-badge enable">达标恢复</span>
      </span>
    </div>
  );
}

function RuleControls({
  definition,
  values,
  rules,
  disabled,
  onChange,
}: {
  definition: AutomationRuleDefinition;
  values: Record<string, number>;
  rules: RuleConfiguration["rules"];
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
              ceiling={ruleValueCeiling(definition.code, parameter.key, rules)}
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
  ceiling = null,
  definitionLabel,
  parameter,
  value,
  disabled,
  onChange,
}: {
  /** 被其他规则约束出来的硬上限，来自 core 的 ruleValueCeiling；没有约束时为 null。 */
  ceiling?: number | null;
  definitionLabel: string;
  parameter: AutomationRuleDefinition["parameters"][number];
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const interactionStep = 0.1;
  const [headroom, setHeadroom] = useState(() => getRuleSliderMaximum(parameter.key, value));

  useEffect(() => {
    setHeadroom((current) => Math.max(current, getRuleSliderMaximum(parameter.key, value)));
  }, [parameter.key, value]);

  // 存量配置里 value 可能已经超出硬上限（旧版界面存得下），这时滑块顶到头、上调键
  // 禁用，但上面显示的仍是真实值——只能往下调回合法区间。
  const maximum = resolveRuleSliderMaximum(ceiling, headroom);

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
      <span className="rule-range-scale">
        <span>0</span>
        <span>安全 ↔ 超限</span>
        <span title={ceiling === null ? undefined : "上限受其他规则约束，不能再往上调"}>
          {formatRuleValue(maximum, parameter.step)}{ceiling === null ? "" : " ·封顶"}
        </span>
      </span>
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
