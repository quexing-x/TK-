import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { CheckCircle2, CircleCheck, CircleX, Download, FileSpreadsheet, Pencil, RefreshCcw, Rocket, Settings2, Trash2, Upload, X } from "lucide-react";
import { CreationPresetConfigSchema, defaultCreationPresetConfig, getCreationTemplateReadiness, type AccountConfig, type AccountProviderCapabilities, type LaunchCopyPreviewRecord, type LaunchManualVerificationInput, type LaunchPlanItemRecord, type LaunchPresetInput, type LaunchPresetRecord, type LaunchSheetImportResult, type ManagedEntityRecord, type MultiAccountLaunchPlanRecord, type ProviderConnection } from "@tk-auto/core";
import { api, type LaunchExecutionResult } from "./api";
import { useAuth } from "./AuthGate";
import { downloadLaunchTemplate, readLaunchSpreadsheet } from "./launch-sheet";
import { canUseCopySource, canUseLaunchTarget } from "./provider-capability-view";
import { createLaunchProgressPoller } from "./launch-progress-polling";

type LaunchMode = "single" | "multi" | "copy";
type LaunchDispatchMode = "queue" | "immediate";
type LaunchFeedback = {
  tone: "success" | "warning" | "danger";
  title: string;
  lines: string[];
};

type LaunchAccountReadiness = {
  account: AccountConfig;
  ready: boolean;
  checks: Array<{ label: string; passed: boolean }>;
};

/** Mirrors the service's final manual-creation authorization boundary. */
function isLaunchExecutionReady(
  _account: AccountConfig,
  connection: ProviderConnection | null | undefined,
  capabilities: AccountProviderCapabilities | undefined,
  mode: "create" | "copy",
): boolean {
  return connection?.status === "ready"
    && canUseLaunchTarget(capabilities, mode);
}

function launchAccountReadiness(
  account: AccountConfig,
  connection: ProviderConnection | null | undefined,
  capabilities: AccountProviderCapabilities | undefined,
  mode: "create" | "copy",
): LaunchAccountReadiness {
  const checks = [
    { label: "接入检测通过", passed: connection?.status === "ready" },
    { label: "具备创建权限", passed: canUseLaunchTarget(capabilities, mode) },
  ];
  return { account, checks, ready: checks.every((check) => check.passed) };
}

const freshPreset = (): LaunchPresetInput => ({
  name: "基础预设",
  region: "未设置",
  dailyBudget: 100,
  bid: null,
  startAt: null,
  endAt: null,
  initialStatus: "enabled",
  creationConfig: defaultCreationPresetConfig,
});

export function LaunchPage({ accounts, accountCapabilities, preferredAccountId, onError }: { accounts: AccountConfig[]; accountCapabilities: Record<string, AccountProviderCapabilities>; preferredAccountId: string; onError: (message: string | null) => void }) {
  const auth = useAuth();
  const [launchMode, setLaunchMode] = useState<LaunchMode>("single");
  const [dispatchMode, setDispatchMode] = useState<LaunchDispatchMode>("queue");
  const [sourceAccountId, setSourceAccountId] = useState(accounts[0]?.id ?? "");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [sourceAds, setSourceAds] = useState<ManagedEntityRecord[]>([]);
  const [sourceAdId, setSourceAdId] = useState("");
  const [copyPreview, setCopyPreview] = useState<LaunchCopyPreviewRecord | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const [presets, setPresets] = useState<LaunchPresetRecord[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetForm, setPresetForm] = useState<LaunchPresetInput>(freshPreset);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [plans, setPlans] = useState<MultiAccountLaunchPlanRecord[]>([]);
  const [planItems, setPlanItems] = useState<Record<string, LaunchPlanItemRecord[]>>({});
  const [activePlanIds, setActivePlanIds] = useState<string[]>([]);
  const [connections, setConnections] = useState<Record<string, ProviderConnection | null>>({});
  const [sheet, setSheet] = useState<LaunchSheetImportResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [executionFeedback, setExecutionFeedback] = useState<LaunchFeedback | null>(null);
  const [presetFeedback, setPresetFeedback] = useState<LaunchFeedback | null>(null);
  const [verificationTarget, setVerificationTarget] = useState<{ planId: string; item: LaunchPlanItemRecord } | null>(null);
  const [verificationForm, setVerificationForm] = useState<LaunchManualVerificationInput>({
    decision: "confirmed-not-created",
    evidence: "",
    note: "",
    campaignId: null,
    adGroupId: null,
    adId: null,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});

  const selectedPreset = presets.find((item) => item.id === presetId) ?? null;
  const selectedPresetCreationConfig = CreationPresetConfigSchema.parse(selectedPreset?.creationConfig ?? {});
  const selectedPresetReadiness = getCreationTemplateReadiness(selectedPresetCreationConfig);
  const selectedPresetExecutionReady = selectedPresetReadiness.ready;
  const selectedPresetLaunchReady = launchMode === "copy"
    ? selectedPresetReadiness.ready
    : selectedPresetExecutionReady;
  const canManageLaunchPresets = auth.status.permissions.includes("launch:manage");
  const canDispatchLaunch = auth.status.permissions.includes("ads:operate");
  const createTargets = useMemo(
    () => accounts.filter((account) =>
      isLaunchExecutionReady(
        account,
        connections[account.id],
        accountCapabilities[account.id],
        "create",
      ),
    ),
    [accountCapabilities, accounts, connections],
  );
  const copySources = useMemo(
    () => accounts.filter((account) =>
      connections[account.id]?.status === "ready"
      && canUseCopySource(accountCapabilities[account.id]),
    ),
    [accountCapabilities, accounts, connections],
  );
  const copyTargets = useMemo(
    () => accounts.filter((account) =>
      isLaunchExecutionReady(
        account,
        connections[account.id],
        accountCapabilities[account.id],
        "copy",
      ),
    ),
    [accountCapabilities, accounts, connections],
  );
  const accountReadiness = useMemo(
    () => accounts.map((account) => launchAccountReadiness(
      account,
      connections[account.id],
      accountCapabilities[account.id],
      launchMode === "copy" ? "copy" : "create",
    )),
    [accountCapabilities, accounts, connections, launchMode],
  );
  const unreadyAccountCount = accountReadiness.filter((item) => !item.ready).length;
  const sourceAccounts = launchMode === "copy" ? copySources : createTargets;
  const targets = launchMode === "copy" ? copyTargets : createTargets;
  const availableTargets = useMemo(
    () => launchMode === "copy" ? targets.filter((account) => account.id !== sourceAccountId) : targets,
    [launchMode, sourceAccountId, targets],
  );
  const visibleTargets = useMemo(() => {
    const query = accountQuery.trim().toLocaleLowerCase();
    return query
      ? availableTargets.filter((account) => account.displayName.toLocaleLowerCase().includes(query))
      : availableTargets;
  }, [accountQuery, availableTargets]);
  const selectedAccountIds = launchMode === "single" ? (sourceAccountId ? [sourceAccountId] : []) : targetIds;
  const notReadyAccountIds = selectedAccountIds.filter((accountId) =>
    connections[accountId]?.status !== "ready"
    || !canUseLaunchTarget(accountCapabilities[accountId], launchMode === "copy" ? "copy" : "create"),
  );
  const copySourceReady = launchMode !== "copy" || copySources.some((account) => account.id === sourceAccountId);
  const copyTaskCount = targetIds.length * (sheet?.rows.length ?? 0);
  const canPreviewCopy = Boolean(
    launchMode === "copy"
      && sourceAccountId
      && sourceAdId
      && targetIds.length > 0
      && copyTaskCount >= 1
      && copyTaskCount <= 3
      && copySourceReady
      && notReadyAccountIds.length === 0
      && presetId
      && selectedPresetLaunchReady
      && sheet
      && sheet.errors.length === 0,
  );
  const canSave = Boolean(canManageLaunchPresets && canDispatchLaunch && selectedAccountIds.length > 0 && notReadyAccountIds.length === 0 && copySourceReady && presetId && selectedPresetLaunchReady && sheet && sheet.errors.length === 0 && sheet.rows.length > 0 && (launchMode !== "copy" || (copyPreview?.safeToCreate && copyPreview.blockers.length === 0)));
  const publishBlockers = [
    !canManageLaunchPresets ? "当前角色缺少创建计划所需的 launch:manage 权限。" : null,
    !canDispatchLaunch ? "当前角色缺少执行创建所需的 ads:operate 权限。" : null,
    selectedAccountIds.length === 0 ? "请选择至少一个已接入的发布账户。" : null,
    notReadyAccountIds.length > 0 ? "所选账户连接异常，请先在用户管理重新完成接入。" : null,
    !presetId ? "请选择广告预设。" : null,
    presetId && !selectedPresetLaunchReady ? "当前预设参数映射尚未完成，请先在高级自定义中补全。" : null,
    !sheet ? "请导入创建信息表。" : null,
    sheet && sheet.errors.length > 0 ? "请先修正导入表错误。" : null,
    launchMode === "copy" && !sourceAdId ? "请选择稳定 ID 对应的源广告。" : null,
    launchMode === "copy" && !copySourceReady ? "源账户缺少广告读取能力，请重新检测接入。" : null,
    launchMode === "copy" && copyTaskCount > 3 ? "复制迁移当前每次最多 3 个逐项任务。" : null,
    launchMode === "copy" && !copyPreview ? "请先生成并核对复制差异预览。" : null,
    launchMode === "copy" && copyPreview && !copyPreview.safeToCreate ? "复制差异预览仍有阻断项。" : null,
  ].filter((item): item is string => Boolean(item));

  const load = async () => {
    const [nextPresets, nextPlans, queuedPlanIds, connectionLists] = await Promise.all([
      api.getLaunchPresets(),
      api.getLaunchPlans(),
      api.getQueuedLaunchPlanIds(),
      Promise.all(accounts.map(async (account) => [account.id, (await api.getConnections(account.id)).find((item) => item.kind === account.providerKind) ?? null] as const)),
    ]);
    setPresets(nextPresets);
    setPlans(nextPlans);
    setActivePlanIds(queuedPlanIds);
    // Connection availability must not wait for historical task-detail reads.
    // A failed/slow plan detail must never make a ready account look unconnected.
    setConnections(Object.fromEntries(connectionLists));
    const itemLists = await Promise.all(nextPlans.map(async (plan) => [plan.id, await api.getLaunchPlanItems(plan.id)] as const));
    setPlanItems(Object.fromEntries(itemLists));
    setPresetId((current) => current && nextPresets.some((item) => item.id === current) ? current : (nextPresets[0]?.id ?? ""));
    onError(null);
  };
  loadRef.current = load;
  useEffect(() => { void load().catch((cause) => onError(messageOf(cause))); }, [onError]);
  useEffect(() => {
    const poller = createLaunchProgressPoller(() => {
      void loadRef.current().catch((cause) => onError(messageOf(cause)));
    });
    poller.reconcile(activePlanIds);
    return () => poller.stop();
  }, [activePlanIds.length, onError]);
  useEffect(() => {
    if (sourceAccounts.length === 0) {
      setSourceAccountId("");
      setTargetIds([]);
      return;
    }
    setSourceAccountId((current) =>
      sourceAccounts.some((account) => account.id === current)
        ? current
        : sourceAccounts.find((account) => account.id === preferredAccountId)?.id ?? sourceAccounts[0]?.id ?? "",
    );
    setTargetIds((current) => current.filter((id) =>
      targets.some((account) => account.id === id)
        && (launchMode !== "copy" || id !== sourceAccountId),
    ));
  }, [launchMode, preferredAccountId, sourceAccountId, sourceAccounts, targets]);
  useEffect(() => {
    if (launchMode !== "copy" || !sourceAccountId) {
      setSourceAds([]);
      setSourceAdId("");
      return;
    }
    void api.getManagedEntities(sourceAccountId)
      .then((entities) => {
        const ads = entities.filter((entity) => entity.entityType === "ad" && !entity.ignored);
        setSourceAds(ads);
        setSourceAdId((current) => ads.some((ad) => ad.externalId === current) ? current : "");
      })
      .catch((cause) => onError(messageOf(cause)));
  }, [launchMode, onError, sourceAccountId]);
  useEffect(() => {
    setCopyPreview(null);
  }, [launchMode, presetId, sheet, sourceAccountId, sourceAdId, targetIds]);
  const importFile = async (file: File | undefined) => {
    if (!file || !selectedPreset) return;
    try {
      setBusy(true);
      const result = await readLaunchSpreadsheet(file, selectedPreset);
      setSheet(result);
      setFileName(file.name);
      onError(result.errors.length ? `表格有 ${result.errors.length} 个错误，请修正后重新导入。` : null);
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };

  const savePreset = async () => {
    if (!canManageLaunchPresets) {
      setPresetFeedback({
        tone: "warning",
        title: "当前登录账户没有预设管理权限",
        lines: ["请使用具备 launch:manage 权限的开发者、管理员或操作员账户登录。"],
      });
      return;
    }
    try {
      setBusy(true);
      const isUpdating = Boolean(editingPresetId);
      const saved = editingPresetId
        ? await api.updateLaunchPreset(editingPresetId, presetForm)
        : await api.createLaunchPreset(presetForm);
      setPresetForm({
        name: saved.name,
        region: saved.region,
        dailyBudget: saved.dailyBudget,
        bid: saved.bid,
        startAt: saved.startAt,
        endAt: saved.endAt,
        initialStatus: saved.initialStatus,
        creationConfig: saved.creationConfig,
      });
      setEditingPresetId(saved.id);
      await load();
      onError(null);
      setPresetFeedback({
        tone: "success",
        title: isUpdating ? "广告预设已更新" : "广告预设已新增",
        lines: [`“${saved.name}”已保存，可在下方列表选择并用于导入创建信息。`],
      });
    } catch (cause) {
      const message = messageOf(cause);
      onError(message);
      setPresetFeedback({ tone: "danger", title: "广告预设未保存", lines: [message] });
    }
    finally { setBusy(false); }
  };
  const editPreset = (preset: LaunchPresetRecord) => {
    setEditingPresetId(preset.id);
    setPresetForm({ name: preset.name, region: preset.region, dailyBudget: preset.dailyBudget, bid: preset.bid, startAt: preset.startAt, endAt: preset.endAt, initialStatus: preset.initialStatus, creationConfig: preset.creationConfig });
  };
  const updateCreationConfig = (patch: Partial<LaunchPresetInput["creationConfig"]>) => {
    setPresetForm((value) => ({ ...value, creationConfig: { ...(value.creationConfig ?? defaultCreationPresetConfig), ...patch } }));
  };
  const presetCreationConfig = CreationPresetConfigSchema.parse(presetForm.creationConfig ?? {});
  const advancedTemplateReadiness = getCreationTemplateReadiness(presetCreationConfig);
  const advancedExecutionReady = advancedTemplateReadiness.ready;
  const removePreset = async (id: string) => {
    try { setBusy(true); await api.deleteLaunchPreset(id); await load(); onError(null); }
    catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const generateCopyPreview = async () => {
    if (launchMode !== "copy" || !sheet || !sourceAdId || !presetId || targetIds.length === 0) return;
    try {
      setBusy(true);
      const preview = await api.createLaunchCopyPreview({
        sourceAccountId,
        sourceAdId,
        targetAccountIds: targetIds,
        launchPresetId: presetId,
        launchRows: sheet.rows,
      });
      setCopyPreview(preview);
      onError(preview.safeToCreate ? null : preview.blockers[0] ?? "复制差异预览存在阻断项。");
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const savePlan = async () => {
    if (!sheet || !canSave) return;
    try {
      setBusy(true);
      setExecutionFeedback(null);
      const plan = await api.createLaunchPlan({
        mode: launchMode,
        sourceAccountId: launchMode === "copy" ? sourceAccountId : selectedAccountIds[0] ?? sourceAccountId,
        sourceAdId: launchMode === "copy" ? sourceAdId : null,
        copyPreviewId: launchMode === "copy" ? copyPreview?.id ?? null : null,
        targetAccountIds: selectedAccountIds,
        launchPresetId: presetId,
        launchRows: sheet.rows,
      });
      if (dispatchMode === "immediate") {
        const execution = await api.executeLaunchPlan(plan.id);
        setExecutionFeedback(summarizeExecution(execution, accounts));
      } else {
        await api.queueLaunchPlan(plan.id);
        setActivePlanIds((current) => [...new Set([...current, plan.id])]);
        setExecutionFeedback({ tone: "warning", title: "已加入后台创建队列", lines: ["页面将持续刷新逐项状态；关闭本页不会中断已领取的任务。"] });
      }
      setSheet(null); setFileName(""); setTargetIds([]); setCopyPreview(null);
      if (fileInput.current) fileInput.current.value = "";
      await load(); onError(null);
    } catch (cause) {
      setExecutionFeedback(null);
      onError(messageOf(cause));
    }
    finally { setBusy(false); }
  };
  const cancelPlan = async (planId: string) => {
    try { setBusy(true); await api.cancelLaunchPlan(planId); await load(); onError(null); }
    catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const retryPlanItem = async (planId: string, itemId: string) => {
    try {
      setBusy(true);
      const execution = await api.retryLaunchPlanItem(planId, itemId);
      setExecutionFeedback(summarizeExecution(execution, accounts));
      await load();
      onError(null);
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const verifyPlanItem = async () => {
    if (!verificationTarget) return;
    try {
      setBusy(true);
      await api.verifyLaunchPlanItem(
        verificationTarget.planId,
        verificationTarget.item.itemId,
        verificationForm,
      );
      setVerificationTarget(null);
      setVerificationForm({ decision: "confirmed-not-created", evidence: "", note: "", campaignId: null, adGroupId: null, adId: null });
      await load();
      onError(null);
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };

  return <section className="page-stack launch-page">
    <div className="panel launch-hero"><span><Rocket size={28} /></span><div><span className="eyebrow">多账户投放</span><h2>预设统一配置，表格只填系列、广告组、视频和产品 URL</h2><p>完整创建协议由当前账户会话提供；预算、出价、地区与创建时间等由广告预设统一覆盖。</p></div><span className={selectedPresetLaunchReady ? "status active" : "status warning"}>{selectedPresetLaunchReady ? "创建参数已就绪" : "创建参数待完善"}</span></div>

    <nav aria-label="广告创建流程" className="launch-workflow-steps">
      <span className="active"><b>1</b><strong>选择方式</strong><small>确定创建范围</small></span>
      <span className={selectedAccountIds.length > 0 ? "complete" : ""}><b>2</b><strong>账户与预设</strong><small>配置发布上下文</small></span>
      <span className={sheet?.errors.length === 0 && sheet.rows.length ? "complete" : ""}><b>3</b><strong>导入校验</strong><small>核对创建内容</small></span>
      <span className={canSave ? "ready" : ""}><b>4</b><strong>执行发布</strong><small>进入后台队列</small></span>
    </nav>

    <div className="launch-workbench">
      <aside className="launch-mode-sidebar">

    <div className="panel launch-mode-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>选择创建方式</h2><p>先选业务目标，系统只展示当前操作所需的信息。</p></div></div></div><div className="launch-mode-options">{([['single','单账户批量创建','向一个账户批量创建广告'],['multi','多账户同时发布','共享视频代码到 Post ID 映射，各账户仅使用自己的 Cookie 会话'],['copy','跨账户复制迁移','用稳定 ID 冻结源结构，并在目标账户重新创建']] as const).map(([mode,title,description]) => <button className={launchMode === mode ? 'active' : ''} key={mode} onClick={() => { setLaunchMode(mode); setCopyPreview(null); if (mode === 'single') setTargetIds([]); }} type="button"><strong>{title}</strong><span>{description}</span></button>)}</div></div>

        <div className="launch-sidebar-summary">
          <span><small>已选账户</small><strong>{selectedAccountIds.length}</strong></span>
          <span><small>导入条目</small><strong>{sheet?.rows.length ?? 0}</strong></span>
          <span><small>待处理计划</small><strong>{activePlanIds.length}</strong></span>
        </div>
      </aside>

      <main className="launch-workspace">

    <div className="panel launch-scope-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>发布账户</h2><p>{launchMode === "single" ? "选择一个账户，本批表格将在该账户中从零创建。" : launchMode === "copy" ? "先按稳定 ID 选择源广告，再选择 1–3 个目标逐项任务。" : "选择多个账户；同名系列复用，广告组与广告均创建新 ID。"}</p></div></div><button className="secondary-button compact-button" disabled={busy} onClick={() => void load().catch((cause) => onError(messageOf(cause)))} title="只重新读取已保存的接入状态；如需拉取广告数据，请到用户管理执行只读同步。" type="button"><RefreshCcw size={14} /> 重新读取状态</button></div><div className="launch-account-summary">
      <div className="launch-account-summary-head"><div><strong>账户创建就绪状态</strong><span>{accounts.length ? `${targets.length} 个可发布 · ${unreadyAccountCount} 个待完善` : "尚未添加账户"}</span></div><button className="secondary-button compact-button" onClick={() => { window.location.hash = "#users"; }} type="button"><Settings2 size={14} /> 前往用户管理</button></div>
      {accounts.length === 0 ? <p className="launch-account-empty">先在“用户管理”添加广告账户并完成接入，随后可回到此处选择发布账户。</p> : <div className="launch-account-readiness-grid">{accountReadiness.map(({ account, checks, ready }) => <article className={ready ? "launch-account-readiness ready" : "launch-account-readiness"} key={account.id}><header><div><strong>{account.displayName}</strong><span>{account.providerKind === "cookie" ? "Cookie 接入" : "Marketing API"}</span></div><em className={ready ? "status active" : "status warning"}>{ready ? "可发布" : "待完善"}</em></header><div>{checks.map((check) => <span className={check.passed ? "passed" : "missing"} key={check.label}>{check.passed ? <CircleCheck size={14} /> : <CircleX size={14} />}{check.label}</span>)}</div></article>)}</div>}
    </div><div className="form-grid">
      {targets.length === 0 ? <div className="launch-target-empty"><CircleX size={18} /><div><strong>暂时没有可发布账户</strong><span>人工真实创建只要求接入检测通过且具备创建权限；自动化开关和执行模式不再阻止手动发布。</span></div><button className="secondary-button compact-button" onClick={() => { window.location.hash = "#users"; }} type="button">去完善账户</button></div> : <>
        {launchMode === "single" && <label className="field"><span>创建账户</span><select value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}><option value="">请选择</option>{sourceAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select><small>仅显示已授权创建能力的账户。</small></label>}
        {launchMode === "copy" && <><label className="field"><span>源广告账户</span><select value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}><option value="">请选择</option>{sourceAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select><small>源账户只需具备广告读取能力。</small></label><label className="field"><span>源广告（稳定 ID）</span><select value={sourceAdId} onChange={(event) => setSourceAdId(event.target.value)}><option value="">请选择已同步广告</option>{sourceAds.map((ad) => <option key={ad.externalId} value={ad.externalId}>{ad.name} · {ad.externalId}</option>)}</select><small>不会按广告名称、广告组名称或系列名称回退定位。</small></label></>}
        {launchMode !== "single" && <div className="field wide target-account-selector"><span>{launchMode === "copy" ? "目标账户（复制迁移）" : "发布账户（可多选）"}</span><div className="target-account-toolbar"><input aria-label="搜索可用发布账户" placeholder="搜索已接入账户" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} /><span>已选 {targetIds.length} / {availableTargets.length}</span><button className="secondary-button compact-button" onClick={() => setTargetIds(visibleTargets.slice(0, launchMode === "copy" ? 3 : visibleTargets.length).map((account) => account.id))} type="button">全选当前结果</button><button className="secondary-button compact-button" onClick={() => setTargetIds([])} type="button">清空</button></div><div className="target-account-grid">{visibleTargets.length === 0 ? <p className="target-account-empty">没有匹配的可用账户。</p> : visibleTargets.map((account) => <label key={account.id}><input checked={targetIds.includes(account.id)} disabled={launchMode === "copy" && !targetIds.includes(account.id) && targetIds.length >= 3} onChange={(event) => setTargetIds((current) => event.target.checked ? [...new Set([...current, account.id])].slice(0, launchMode === "copy" ? 3 : 100) : current.filter((id) => id !== account.id))} type="checkbox" /><span>{account.displayName}</span><small>已接入 · {account.providerKind === "cookie" ? "Cookie" : "Marketing API"}</small></label>)}</div></div>}
      </>}
    </div></div>

    <div className="panel launch-readiness-panel"><div className="panel-heading"><div><span className="panel-icon"><CheckCircle2 size={18} /></span><div><h2>创建检查</h2><p>软件会校验账户接入和预设映射；通过后只需导入表格。</p></div></div><span className={selectedPresetLaunchReady && notReadyAccountIds.length === 0 ? "status active" : "status warning"}>{selectedPresetLaunchReady && notReadyAccountIds.length === 0 ? "可创建" : "待完善"}</span></div><div className="sheet-rule-grid">
      <article><strong>数据读取与启停</strong><span>{selectedAccountIds.length === 0 ? "请选择要发布的账户。" : notReadyAccountIds.length === 0 ? `已选 ${selectedAccountIds.length} 个账户均已通过连接检测。` : `有 ${notReadyAccountIds.length} 个已选账户连接异常。`}</span></article>
      <article><strong>视频素材</strong><span>同一视频代码使用高级自定义中的共享 TikTok Post ID 映射；不同账户只切换各自 Cookie 会话。</span></article>
      <article><strong>广告预设</strong><span>{selectedPreset ? `当前使用“${selectedPreset.name}”` : "请选择广告预设。"}</span></article>
      <article><strong>创建功能</strong><span>{selectedAccountIds.length === 0 ? "请选择发布账户。" : notReadyAccountIds.length > 0 ? "所选账户的连接或创建能力尚未就绪。" : selectedPresetLaunchReady ? "当前预设参数完整，日常投放无需重复填写内部字段。" : "当前预设参数不完整，不能发起创建。"}</span></article>
      <article><strong>导入信息</strong><span>{sheet?.errors.length === 0 && sheet.rows.length ? `已校验 ${sheet.rows.length} 条创建信息。` : "导入表只需填写系列名称、广告组名称、视频代码和产品 URL。"}</span></article>
    </div></div>

    <div className="panel launch-preset-panel"><div className="panel-heading"><div><span className="panel-icon"><Pencil size={18} /></span><div><h2>广告预设模板</h2><p>预算、出价、创建时间和初始状态在此统一设置；保存后可复用。</p></div></div></div><div className="form-grid">
      <label className="field"><span>预设名称</span><input value={presetForm.name} onChange={(event) => setPresetForm((value) => ({ ...value, name: event.target.value }))} /></label>
      <label className="field"><span>投放地区</span><input placeholder="例如：US、美国、US/CA" value={presetForm.region} onChange={(event) => setPresetForm((value) => ({ ...value, region: event.target.value }))} /></label>
      <label className="field"><span>广告组日预算</span><input min="0.01" step="0.01" type="number" value={presetForm.dailyBudget} onChange={(event) => setPresetForm((value) => ({ ...value, dailyBudget: Number(event.target.value) }))} /></label>
      <label className="field"><span>出价（留空为自动）</span><input min="0" step="0.01" type="number" value={presetForm.bid ?? ""} onChange={(event) => setPresetForm((value) => ({ ...value, bid: event.target.value === "" ? null : Number(event.target.value) }))} /></label>
      <label className="field"><span>创建时间（留空为立即）</span><input type="datetime-local" value={toLocalInput(presetForm.startAt)} onChange={(event) => setPresetForm((value) => ({ ...value, startAt: toIso(event.target.value) }))} /><span className="quick-time-actions"><button onClick={() => setPresetForm((value) => ({ ...value, startAt: scheduledStartAt("tonight") }))} type="button">当天 24:00</button><button onClick={() => setPresetForm((value) => ({ ...value, startAt: scheduledStartAt("tomorrow-morning") }))} type="button">次日 06:00</button></span></label>
      <label className="field"><span>初始状态</span><select value={presetForm.initialStatus} onChange={(event) => setPresetForm((value) => ({ ...value, initialStatus: event.target.value as LaunchPresetInput["initialStatus"] }))}><option value="disabled">关闭</option><option value="enabled">开启</option></select></label>
    </div><div className="creation-template-note"><strong>内置创建协议</strong><span>用户无需再抓取创建接口；两条 cURL 提供当前账户会话，广告预设负责预算、地区、出价和时间等业务参数。</span></div>{!canManageLaunchPresets && <div className="preset-save-feedback warning"><strong>当前账号无预设管理权限</strong><span>登录角色为“{auth.status.user?.role ?? "未知"}”，无法保存广告预设；请切换至开发者、管理员或操作员账号。</span></div>}{presetFeedback && <div className={`preset-save-feedback ${presetFeedback.tone}`}><strong>{presetFeedback.title}</strong><span>{presetFeedback.lines[0]}</span></div>}<div className="form-actions"><button className="primary-button" disabled={busy || !canManageLaunchPresets} onClick={() => void savePreset()} title={canManageLaunchPresets ? undefined : "需要 launch:manage 权限"} type="button">{editingPresetId ? "更新预设" : "新建预设"}</button>{editingPresetId && <button className="secondary-button" onClick={() => { setEditingPresetId(null); setPresetForm(freshPreset()); setPresetFeedback(null); }} type="button">取消编辑</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>预设</th><th>地区</th><th>预算</th><th>出价</th><th>创建时间</th><th>初始状态</th><th>操作</th></tr></thead><tbody>{presets.map((preset) => <tr key={preset.id}><td>{preset.name}</td><td>{preset.region}</td><td>{preset.dailyBudget}</td><td>{preset.bid ?? "自动"}</td><td>{preset.startAt ? new Date(preset.startAt).toLocaleString() : "立即"}</td><td>{preset.initialStatus === "enabled" ? "开启" : "关闭"}</td><td><button disabled={busy} onClick={() => editPreset(preset)} type="button">编辑</button> <button disabled={busy} onClick={() => void removePreset(preset.id)} type="button">删除</button></td></tr>)}</tbody></table></div>
    </div>

    <details className="panel creation-config-panel"><summary><span><Settings2 size={18} /></span><div><strong>高级自定义参数</strong><small>真实创建映射随预设保存；日常投放无需展开</small></div><em className={advancedExecutionReady ? "status active" : "status warning"}>{advancedExecutionReady ? "参数映射完整" : "参数映射不完整"}</em></summary><div className="creation-config-body"><div className="creation-template-note"><strong>{advancedExecutionReady ? "当前预设参数映射完整" : "当前预设尚未完成参数映射"}</strong><span>{advancedExecutionReady ? "创建时使用当前账户 Cookie 会话并覆盖下列业务参数。" : "请按参数对照补全真实创建需要的业务映射；账户内部系列 ID 不作为跨账户必填项。"}</span></div><div className="creation-config-reference"><div><strong>参数</strong><strong>来源 / 获取位置</strong></div><div><span>营销目标、购买方式、预算方式</span><span>TikTok Ads Manager 新建推广系列页</span></div><div><span>计费方式、优化目标、转化事件、像素</span><span>广告组设置与事件管理器</span></div><div><span>广告身份、行动号召</span><span>广告创建页的身份与创意设置</span></div><div><span>地区与版位代码</span><span>广告组定向设置</span></div></div><button className="secondary-button creation-guide-button" onClick={() => { window.location.hash = "#manual"; }} type="button">查看完整参数对照与获取方式</button><div className="form-grid">
      <label className="field"><span>营销目标</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.objectiveType ?? ""} onChange={(event) => updateCreationConfig({ objectiveType: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>购买方式</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.buyingType ?? ""} onChange={(event) => updateCreationConfig({ buyingType: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>系列预算方式</span><input inputMode="numeric" placeholder="例如 0" value={presetCreationConfig.campaignBudgetMode ?? ""} onChange={(event) => updateCreationConfig({ campaignBudgetMode: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>广告组预算方式</span><input inputMode="numeric" placeholder="例如 0" value={presetCreationConfig.adBudgetMode ?? ""} onChange={(event) => updateCreationConfig({ adBudgetMode: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>计费方式</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.pricing ?? ""} onChange={(event) => updateCreationConfig({ pricing: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>优化目标</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.optimizeGoal ?? ""} onChange={(event) => updateCreationConfig({ optimizeGoal: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>转化事件</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.externalAction ?? ""} onChange={(event) => updateCreationConfig({ externalAction: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>广告身份类型</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.identityType ?? ""} onChange={(event) => updateCreationConfig({ identityType: nullableInteger(event.target.value) })} /></label>
      {presetCreationConfig.identityType !== 0 && <label className="field"><span>广告身份 ID</span><input placeholder="从账户后台复制" value={presetCreationConfig.identityId ?? ""} onChange={(event) => updateCreationConfig({ identityId: event.target.value || null })} /></label>}
      <label className="field"><span>行动号召 ID</span><input placeholder="从账户后台复制" value={presetCreationConfig.callToActionId ?? ""} onChange={(event) => updateCreationConfig({ callToActionId: event.target.value || null })} /></label>
      <label className="field"><span>像素 ID</span><input placeholder="从账户后台复制" value={presetCreationConfig.pixelId ?? ""} onChange={(event) => updateCreationConfig({ pixelId: event.target.value || null })} /></label>
      <label className="field"><span>地区代码（逗号分隔）</span><input inputMode="numeric" placeholder="例如 840,124" value={(presetCreationConfig.countryCodes ?? []).join(",")} onChange={(event) => updateCreationConfig({ countryCodes: parseIntegerList(event.target.value) })} /></label>
      <label className="field"><span>版位代码（逗号分隔）</span><input inputMode="numeric" placeholder="例如 3000" value={(presetCreationConfig.placementIds ?? []).join(",")} onChange={(event) => updateCreationConfig({ placementIds: parseIntegerList(event.target.value) })} /></label>
      <label className="field wide"><span>TikTok Post 映射（视频代码 | Post ID）</span><textarea placeholder="每行一条；所有账户共用同一映射" value={formatVideoPostMappings(presetCreationConfig.videoPostMappings)} onChange={(event) => updateCreationConfig({ videoPostMappings: parseVideoPostMappings(event.target.value) })} /><small>账户仅通过 Cookie 区分；已映射代码在所有账户中复用相同 TikTok Post。</small></label>
    </div><div className="form-actions"><button className="primary-button" disabled={busy || !canManageLaunchPresets || !advancedExecutionReady} onClick={() => void savePreset()} title={advancedExecutionReady ? undefined : "必须完成真实创建参数映射后才能保存"} type="button">保存高级自定义</button></div></div></details>

    <div className="panel launch-sheet-panel"><div className="panel-heading"><div><span className="panel-icon"><FileSpreadsheet size={18} /></span><div><h2>导入创建信息</h2><p>表格仅保留推广系列名称、广告组名称、视频代码和产品 URL。广告名称自动生成。</p></div></div><button className="secondary-button" onClick={() => void downloadLaunchTemplate().catch((cause) => onError(messageOf(cause)))} type="button"><Download size={16} /> 下载模板</button></div>
      <div className="sheet-rule-grid"><article><strong>1. 选择广告预设</strong><span>{selectedPreset ? `当前：${selectedPreset.name} · ${selectedPreset.region}（预算 ${selectedPreset.dailyBudget}）` : "请先选择预设。"}</span></article><article><strong>2. 表格只填四列</strong><span>推广系列名称、广告组名称、视频代码、产品 URL。</span></article><article><strong>3. 多视频代码</strong><span>同一单元格可用 `；`、`;` 或换行分隔多个代码；每个代码会生成一条广告。</span></article><article><strong>4. 自动命名</strong><span>广告名称使用 YYMMDD:XXX，例如 260716:001。</span></article></div>
      <label className="field" style={{ margin: "0 18px 12px" }}><span>本次使用的广告预设</span><select value={presetId} onChange={(event) => { setPresetId(event.target.value); setSheet(null); }}><option value="">请选择预设</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
      <button className="sheet-dropzone" disabled={busy || !selectedPreset} onClick={() => fileInput.current?.click()} type="button"><Upload size={22} /><strong>{fileName || "选择 .xlsx / .csv 文件"}</strong><span>{selectedPreset ? "导入不会立即创建广告。" : "请先选择广告预设。"}</span></button><input ref={fileInput} accept=".xlsx,.csv" hidden onChange={(event) => void importFile(event.target.files?.[0])} type="file" />
      {sheet && <div className="sheet-result"><div className="sheet-summary"><span className={sheet.errors.length === 0 ? "status active" : "status danger"}>{sheet.errors.length === 0 ? <CheckCircle2 size={14} /> : <X size={14} />}{sheet.errors.length === 0 ? `校验通过：${sheet.rows.length} 条` : `${sheet.errors.length} 个错误`}</span></div>{sheet.errors.length > 0 && <IssueList issues={sheet.errors} />}{sheet.warnings.length > 0 && <IssueList tone="warning" issues={sheet.warnings} />}{sheet.rows.length > 0 && <div className="table-wrap"><table className="sheet-preview-table"><thead><tr><th>来源行</th><th>推广系列</th><th>广告组</th><th>视频代码</th><th>产品 URL</th><th>广告名称</th><th>预算</th><th>出价</th></tr></thead><tbody>{sheet.rows.slice(0, 100).map((row) => <tr key={`${row.rowNumber}-${row.videoCode}`}><td>{row.rowNumber}</td><td>{row.campaignName}</td><td>{row.adGroupName}</td><td>{row.videoCode}</td><td><small>{row.productUrl}</small></td><td>{row.adName}</td><td>{row.dailyBudget}</td><td>{row.bid ?? "自动"}</td></tr>)}</tbody></table></div>}</div>}
      {launchMode === "copy" && <div className="copy-preview-actions"><button className="secondary-button" disabled={busy || !canPreviewCopy} onClick={() => void generateCopyPreview()} type="button">生成复制差异预览</button><small>系统会核对源对象稳定 ID、目标账户素材证据和每一项差异；预览 15 分钟内有效。</small></div>}
      {copyPreview && <div className={copyPreview.safeToCreate ? "creation-template-note copy-preview-result" : "sheet-issues warning copy-preview-result"}><strong>{copyPreview.safeToCreate ? `差异预览已通过 · ${copyPreview.items.length} 项` : "差异预览存在阻断项"}</strong>{copyPreview.blockers.length > 0 && <ul>{copyPreview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}{copyPreview.warnings.length > 0 && <ul>{copyPreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}{copyPreview.items.length > 0 && <div className="table-wrap"><table><thead><tr><th>目标账户</th><th>素材证据</th><th>差异</th></tr></thead><tbody>{copyPreview.items.map((item) => <tr key={`${item.accountId}-${item.itemIndex}`}><td>{accounts.find((account) => account.id === item.accountId)?.displayName ?? item.accountId}</td><td>{item.targetAssetMapping.targetVideoCode}<br /><small>广告 ID：{item.targetAssetMapping.evidenceAdId}</small></td><td>{item.differences.length === 0 ? "与源结构一致" : item.differences.map((difference) => `${copyDifferenceLabel(difference.field)}：${difference.sourceValue ?? "空"} → ${difference.targetValue ?? "空"}`).join("；")}</td></tr>)}</tbody></table></div>}</div>}
      {publishBlockers.length > 0 && <div className="sheet-issues warning publish-blockers" id="publish-blockers"><strong>暂不能发布</strong><ul>{publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      <div className="launch-dispatch-mode"><strong>执行方式</strong><label><input checked={dispatchMode === "queue"} name="launch-dispatch-mode" onChange={() => setDispatchMode("queue")} type="radio" /> 后台队列（默认）</label><label><input checked={dispatchMode === "immediate"} name="launch-dispatch-mode" onChange={() => setDispatchMode("immediate")} type="radio" /> 立即执行（等待本批结果）</label></div><div className="form-actions"><button aria-describedby={publishBlockers.length > 0 ? "publish-blockers" : undefined} className="primary-button" disabled={busy || !canSave} title={publishBlockers[0]} onClick={() => void savePlan()} type="button">{dispatchMode === "immediate" ? "立即创建" : launchMode === "single" ? "创建并发布" : launchMode === "copy" ? "确认差异并发布迁移" : "向所选账户发布"}{sheet?.rows.length ? `（${sheet.rows.length} 条 × ${selectedAccountIds.length} 个账户）` : ""}</button></div>
      {executionFeedback && <div className={executionFeedback.tone === "success" ? "creation-template-note" : `sheet-issues ${executionFeedback.tone}`}><strong>{executionFeedback.title}</strong><ul>{executionFeedback.lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul></div>}
    </div>

    <div className="panel table-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>投放结果</h2><p>后台执行时会自动刷新逐项状态和当前阶段。</p></div></div></div><div className="table-wrap"><table><thead><tr><th>创建内容</th><th>预设</th><th>计划任务</th><th>逐项实时状态</th><th>发布结果</th><th>操作</th></tr></thead><tbody>{plans.length === 0 ? <tr><td colSpan={6}>暂无投放计划。</td></tr> : plans.map((plan) => { const created = plan.executionResults.reduce((total, item) => total + item.createdCount, 0); const failed = plan.executionResults.reduce((total, item) => total + item.failedCount, 0); const unknown = plan.executionResults.reduce((total, item) => total + item.unknownCount, 0); const items = planItems[plan.id] ?? []; const failedItems = items.filter((item) => item.status === "failed"); const unknownItems = items.filter((item) => item.status === "unknown"); return <tr key={plan.id}><td>{plan.sourceAdName}</td><td>{plan.presetName}</td><td>{plan.launchRows.length} 条 × {plan.targetAccountIds.length} 个账户</td><td>{items.length === 0 ? "尚未执行" : <div className="plan-item-progress">{items.map((item) => <small className={`status ${item.status === "succeeded" ? "active" : ["failed", "unknown"].includes(item.status) ? "danger" : "warning"}`} key={item.itemId}>{item.launchRow.adName} · {launchItemStatusLabel(item.status)} · {launchPhaseLabel(item.phase)}</small>)}</div>}</td><td><span className={`status ${plan.status === "completed" ? "active" : plan.status === "cancelled" ? "danger" : "warning"}`}>{plan.status === "completed" ? "已发布" : plan.status === "blocked" ? "未全部完成" : plan.status}</span>{plan.executionResults.length > 0 && <small className="plan-execution-summary">成功 {created} · 失败 {failed} · 待核验 {unknown}</small>}{plan.executionResults.map((item) => { const detail = summarizePlanAccountResult(item); return detail ? <small className={detail.tone === "danger" ? "plan-execution-error" : "plan-execution-summary"} key={item.accountId}>{item.accountId}：{detail.text}</small> : null; })}</td><td>{failedItems.map((item) => <button className="secondary-button compact-button" disabled={busy} key={item.itemId} onClick={() => void retryPlanItem(plan.id, item.itemId)} type="button">重试 {item.launchRow.adName}</button>)}{unknownItems.map((item) => <button className="secondary-button compact-button" disabled={busy} key={item.itemId} onClick={() => setVerificationTarget({ planId: plan.id, item })} type="button">人工核验 {item.launchRow.adName}</button>)}{["blocked", "draft"].includes(plan.status) && <button disabled={busy || items.some((item) => item.status === "running")} onClick={() => void cancelPlan(plan.id)} type="button"><Trash2 size={14} /> 取消</button>}</td></tr>; })}</tbody></table></div></div>

      </main>
    </div>

    {verificationTarget && <LaunchVerificationDialog
      accountName={accounts.find((account) => account.id === verificationTarget.item.accountId)?.displayName ?? verificationTarget.item.accountId}
      busy={busy}
      form={verificationForm}
      item={verificationTarget.item}
      onCancel={() => setVerificationTarget(null)}
      onChange={setVerificationForm}
      onSubmit={() => void verifyPlanItem()}
    />}
  </section>;
}

function IssueList({ issues, tone = "danger" }: { issues: LaunchSheetImportResult["errors"]; tone?: "danger" | "warning" }) { return <div className={`sheet-issues ${tone}`}><strong>{tone === "danger" ? "需要修正" : "导入提示"}</strong><ul>{issues.slice(0, 20).map((issue, index) => <li key={`${issue.rowNumber}-${issue.field}-${index}`}>第 {issue.rowNumber} 行 · {issue.field}：{issue.message}</li>)}</ul></div>; }

function LaunchVerificationDialog({ accountName, busy, form, item, onCancel, onChange, onSubmit }: {
  accountName: string;
  busy: boolean;
  form: LaunchManualVerificationInput;
  item: LaunchPlanItemRecord;
  onCancel: () => void;
  onChange: Dispatch<SetStateAction<LaunchManualVerificationInput>>;
  onSubmit: () => void;
}) {
  const identityLines = launchVerificationIdentityLines(item, accountName);
  return <div className="modal-backdrop"><div aria-labelledby="launch-verification-title" aria-modal="true" className="modal" role="dialog">
    <div className="modal-header"><div><span className="eyebrow">创建结果待确认</span><h2 id="launch-verification-title">人工核验 {item.launchRow.adName}</h2></div><button aria-label="关闭人工核验" disabled={busy} onClick={onCancel} type="button"><X size={18} /></button></div>
    <div className="creation-template-note" role="status"><strong>请先核对任务身份</strong>{identityLines.map((line) => <span key={line}>{line}</span>)}</div>
    <div className="form-grid"><label className="field wide"><span>核验结论</span><select value={form.decision} onChange={(event) => onChange((value) => ({ ...value, decision: event.target.value as LaunchManualVerificationInput["decision"] }))}><option value="confirmed-not-created">确认未创建（之后可显式单项重试）</option><option value="confirmed-succeeded">确认已创建（必须填写三个正式 ID）</option></select></label><label className="field wide"><span>核验证据</span><textarea minLength={10} placeholder="填写后台查询结果、时间、对象状态或其他可复核依据（至少 10 个字符）" value={form.evidence} onChange={(event) => onChange((value) => ({ ...value, evidence: event.target.value }))} /></label><label className="field wide"><span>备注</span><textarea value={form.note} onChange={(event) => onChange((value) => ({ ...value, note: event.target.value }))} /></label>{form.decision === "confirmed-succeeded" && <><label className="field"><span>Campaign ID</span><input value={form.campaignId ?? ""} onChange={(event) => onChange((value) => ({ ...value, campaignId: event.target.value || null }))} /></label><label className="field"><span>Ad Group ID</span><input value={form.adGroupId ?? ""} onChange={(event) => onChange((value) => ({ ...value, adGroupId: event.target.value || null }))} /></label><label className="field"><span>Ad ID</span><input value={form.adId ?? ""} onChange={(event) => onChange((value) => ({ ...value, adId: event.target.value || null }))} /></label></>}</div>
    <div className="form-actions"><button className="primary-button" disabled={busy || form.evidence.trim().length < 10 || (form.decision === "confirmed-succeeded" && (!form.campaignId || !form.adGroupId || !form.adId))} onClick={onSubmit} type="button">保存核验结论</button><button className="secondary-button" disabled={busy} onClick={onCancel} type="button">取消</button></div>
  </div></div>;
}

export function launchVerificationIdentityLines(item: LaunchPlanItemRecord, accountName: string): string[] {
  const evidence = Object.entries(item.evidence)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ") || "暂无 Provider 证据 ID";
  return [
    `账户：${accountName}（${item.accountId}）`,
    `operationId：${item.operationId}`,
    `attemptId：${item.attemptId ?? "无"}`,
    `correlationId：${item.correlationId}`,
    `阶段：${item.phase} · 领取时间：${item.claimedAt ? new Date(item.claimedAt).toLocaleString() : "无"}`,
    evidence,
  ];
}
function toIso(value: string): string | null { return value ? new Date(value).toISOString() : null; }
function nullableInteger(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
function parseIntegerList(value: string): number[] {
  return value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
    .map(Number).filter((item) => Number.isInteger(item));
}

function formatVideoPostMappings(
  mappings: NonNullable<LaunchPresetInput["creationConfig"]>["videoPostMappings"],
): string {
  return (mappings ?? []).map((item) => `${item.videoCode} | ${item.postId}`).join("\n");
}

function parseVideoPostMappings(
  value: string,
): NonNullable<LaunchPresetInput["creationConfig"]>["videoPostMappings"] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    const [videoCode = "", postId = ""] = parts.length >= 3 ? parts.slice(1, 3) : parts;
    return { videoCode, postId };
  });
}
function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function scheduledStartAt(kind: "tonight" | "tomorrow-morning", now = new Date()): string {
  const date = new Date(now);
  date.setSeconds(0, 0);
  date.setDate(date.getDate() + 1);
  if (kind === "tonight") date.setHours(0, 0, 0, 0);
  else date.setHours(6, 0, 0, 0);
  return date.toISOString();
}
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : "创建广告操作失败。"; }

function copyDifferenceLabel(field: LaunchCopyPreviewRecord["items"][number]["differences"][number]["field"]): string {
  return {
    campaignName: "系列名称",
    adGroupName: "广告组名称",
    adName: "广告名称",
    videoCode: "视频代码",
    productUrl: "产品 URL",
  }[field];
}

export function summarizeExecution(
  execution: LaunchExecutionResult,
  accounts: AccountConfig[],
): LaunchFeedback {
  const accountNames = new Map(accounts.map((account) => [account.id, account.displayName]));
  const label = (accountId: string) => accountNames.get(accountId) ?? accountId;
  const failed = execution.results.filter((item) => item.status === "failed");
  const unknown = execution.results.filter((item) => item.status === "unknown");
  const succeeded = execution.results.filter((item) => item.status === "succeeded");
  const syncWarnings = succeeded.filter((item) => item.syncWarning);
  const lines = [
    ...failed.map((item) => `${label(item.accountId)}：${item.message}`),
    ...unknown.map((item) => `${label(item.accountId)}：创建结果待确认，${item.message}`),
    ...syncWarnings.map((item) => `${label(item.accountId)}：广告已创建，但同步警告：${item.syncWarning}`),
  ];
  if (failed.length > 0) {
    return { tone: "danger", title: `创建失败 ${failed.length} 条`, lines };
  }
  if (unknown.length > 0 || syncWarnings.length > 0) {
    return { tone: "warning", title: `成功 ${succeeded.length} 条，另有待处理提示`, lines };
  }
  return {
    tone: "success",
    title: `创建成功 ${succeeded.length} 条`,
    lines: succeeded.map((item) => `${label(item.accountId)}：${item.message}`),
  };
}

export function summarizePlanAccountResult(
  result: MultiAccountLaunchPlanRecord["executionResults"][number],
): { tone: "danger" | "warning"; text: string } | null {
  if (result.failedCount === 0 && result.unknownCount === 0) return null;
  const parts = [
    result.failedCount > 0 ? `明确失败 ${result.failedCount} 条，可单项重试` : "",
    result.unknownCount > 0 ? `创建结果待确认 ${result.unknownCount} 条，禁止重试，需人工核验` : "",
    result.message ?? "",
  ].filter(Boolean);
  return {
    tone: result.failedCount > 0 ? "danger" : "warning",
    text: parts.join("；"),
  };
}

function launchItemStatusLabel(status: LaunchPlanItemRecord["status"]): string {
  return ({ pending: "排队中", running: "执行中", succeeded: "已成功", failed: "明确失败", unknown: "待核验", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function launchPhaseLabel(phase: LaunchPlanItemRecord["phase"]): string {
  return ({ validation: "校验", campaign_draft: "系列草稿", adgroup_draft: "广告组草稿", creative_draft: "广告草稿", publishing: "发布", readback: "回读", sync: "同步" } as Record<string, string>)[phase] ?? phase;
}
