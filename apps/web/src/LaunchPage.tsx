import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleCheck, CircleX, Download, FileSpreadsheet, Pencil, RefreshCcw, Rocket, Settings2, Trash2, Upload, X } from "lucide-react";
import { CreationPresetConfigSchema, defaultCreationPresetConfig, getCreationTemplateReadiness, resolveConfiguredBudgetMode, type AccountConfig, type AccountProviderCapabilities, type LaunchCopyPreviewRecord, type LaunchMigrationTargetConfig, type LaunchPlanItemRecord, type LaunchPresetInput, type LaunchPresetRecord, type LaunchSheetImportResult, type ManagedEntityRecord, type MultiAccountLaunchPlanRecord, type ProviderConnection } from "@tk-auto/core";
import { api, type LaunchExecutionResult } from "./api";
import { useAuth } from "./AuthGate";
import { downloadLaunchTemplate, readLaunchSpreadsheet } from "./launch-sheet";
import {
  accountAccessStatus,
  canUseCopySource,
  canUseLaunchTarget,
  type AccountAccessStatus,
} from "./provider-capability-view";
import { createLaunchProgressPoller } from "./launch-progress-polling";
import { ExpandGroupsPanel } from "./ExpandGroupsPanel";
import { CopyCampaignPanel } from "./CopyCampaignPanel";
import { useOverlays } from "./ui/overlays";
import type { ReadOnlySyncResult } from "@tk-auto/core";

type LaunchMode = "single" | "multi" | "copy" | "expand" | "campaign-copy";
type ConnectionState = {
  accountId: string;
  connection: ProviderConnection | null;
  latestSync: ReadOnlySyncResult | null;
  capabilities: AccountProviderCapabilities;
};
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
  access: AccountAccessStatus | null;
};

export interface SourceAdGroupOption {
  adGroupId: string;
  name: string;
  campaignName: string;
  syncedAt: string;
}

/** Two-level accounts are valid sources; a final ad child is not required. */
export function buildSourceAdGroupOptions(entities: ManagedEntityRecord[]): SourceAdGroupOption[] {
  const campaignNames = new Map(entities
    .filter((entity) => entity.entityType === "campaign")
    .map((entity) => [entity.externalId, entity.name]));
  return entities.flatMap((entity) => {
    if (
      entity.entityType !== "ad-group"
      || entity.ignored
      || !entity.externalId
      || entity.externalId === "0"
    ) return [];
    const name = entity.name?.trim();
    if (!name || name === entity.externalId) return [];
    return [{
      adGroupId: entity.externalId,
      name,
      campaignName: campaignNames.get(entity.parentCampaignId ?? "") ?? "未识别系列",
      syncedAt: entity.syncedAt,
    }];
  }).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

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
  state: ConnectionState | undefined,
  connection: ProviderConnection | null | undefined,
  capabilities: AccountProviderCapabilities | undefined,
  mode: "create" | "copy",
): LaunchAccountReadiness {
  const access = state
    ? accountAccessStatus({
        ...state,
        connection: connection ?? state.connection,
        capabilities: capabilities ?? state.capabilities,
      })
    : null;
  const checks = [
    {
      label: "接入检测通过",
      passed: access?.connectionReady ?? connection?.status === "ready",
    },
    {
      label: mode === "copy" ? "具备原贴迁移权限" : "具备创建权限",
      passed: access
        ? mode === "copy" ? access.copyReady : access.createReady
        : canUseLaunchTarget(capabilities, mode),
    },
  ];
  return { account, checks, ready: checks.every((check) => check.passed), access };
}

const freshPreset = (): LaunchPresetInput => ({
  name: "基础预设",
  region: "未设置",
  dailyBudget: 100,
  bid: null,
  startAt: null,
  endAt: null,
  startAtRule: "absolute",
  initialStatus: "enabled",
  creationConfig: defaultCreationPresetConfig,
});

export function LaunchPage({ accounts, accountCapabilities, connectionStates, preferredAccountId, onConnectionStatesChanged, onManageConnection, onError }: { accounts: AccountConfig[]; accountCapabilities: Record<string, AccountProviderCapabilities>; connectionStates: ConnectionState[]; preferredAccountId: string; onConnectionStatesChanged?: () => Promise<void>; onManageConnection?: (accountId: string) => void; onError: (message: string | null) => void }) {
  const auth = useAuth();
  const { toast, confirm } = useOverlays();
  const [launchMode, setLaunchMode] = useState<LaunchMode>("single");
  const [dispatchMode, setDispatchMode] = useState<LaunchDispatchMode>("queue");
  const [sourceAccountId, setSourceAccountId] = useState(accounts[0]?.id ?? "");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [sourceAdGroups, setSourceAdGroups] = useState<SourceAdGroupOption[]>([]);
  const [sourceAdGroupIds, setSourceAdGroupIds] = useState<string[]>([]);
  const [copyPreview, setCopyPreview] = useState<LaunchCopyPreviewRecord | null>(null);
  const [copyTargetConfigs, setCopyTargetConfigs] = useState<LaunchMigrationTargetConfig[]>([]);
  const [sourceGroupQuery, setSourceGroupQuery] = useState("");
  const [previewSecondsLeft, setPreviewSecondsLeft] = useState(0);
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
  const [planRequestId, setPlanRequestId] = useState(() => crypto.randomUUID());
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [executionFeedback, setExecutionFeedback] = useState<LaunchFeedback | null>(null);
  const [presetFeedback, setPresetFeedback] = useState<LaunchFeedback | null>(null);
  const [expandPresetHost, setExpandPresetHost] = useState<HTMLDivElement | null>(null);
  const [recoveringAccountIds, setRecoveringAccountIds] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const terminalPlanNotificationsReady = useRef(false);
  const notifiedTerminalPlanIds = useRef(new Set<string>());
  const copyPreviewInFlight = useRef(false);

  const selectedPreset = presets.find((item) => item.id === presetId) ?? null;
  const importedCampaignCount = sheet
    ? new Set(sheet.rows.map((row) => row.campaignName.trim()).filter(Boolean)).size
    : 0;
  const accountNameById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.displayName])),
    [accounts],
  );
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
      account.providerKind === "cookie"
      && connections[account.id]?.status === "ready"
      && canUseCopySource(accountCapabilities[account.id]),
    ),
    [accountCapabilities, accounts, connections],
  );
  const copyTargets = useMemo(
    () => accounts.filter((account) =>
      account.providerKind === "cookie"
      && isLaunchExecutionReady(
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
      connectionStates.find((state) => state.accountId === account.id),
      connections[account.id],
      accountCapabilities[account.id],
      launchMode === "copy" ? "copy" : "create",
    )),
    [accountCapabilities, accounts, connections, connectionStates, launchMode],
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
  const visibleSourceAdGroups = useMemo(() => {
    const query = sourceGroupQuery.trim().toLocaleLowerCase();
    return query ? sourceAdGroups.filter((group) => `${group.campaignName} ${group.name} ${group.adGroupId}`.toLocaleLowerCase().includes(query)) : sourceAdGroups;
  }, [sourceAdGroups, sourceGroupQuery]);
  const selectedSourceGroups = sourceAdGroups.filter((group) => sourceAdGroupIds.includes(group.adGroupId));
  const selectedAccountIds = launchMode === "single" ? (sourceAccountId ? [sourceAccountId] : []) : targetIds;
  const notReadyAccountIds = selectedAccountIds.filter((accountId) =>
    connections[accountId]?.status !== "ready"
    || !canUseLaunchTarget(accountCapabilities[accountId], launchMode === "copy" ? "copy" : "create"),
  );
  const copySourceReady = launchMode !== "copy" || copySources.some((account) => account.id === sourceAccountId);
  const copyTaskCount = copyTargetConfigs.reduce((sum, item) => sum + item.quantity, 0) * sourceAdGroupIds.length;
  const copyConfigsValid = targetIds.length > 0
    && copyTargetConfigs.length === targetIds.length
    && copyTargetConfigs.every((item) => targetIds.includes(item.accountId) && item.quantity >= 1 && item.dailyBudget > 0);
  const copyInputReady = Boolean(
    launchMode === "copy"
      && sourceAccountId
      && sourceAdGroupIds.length > 0
      && targetIds.length > 0
      && copyTaskCount >= 1
      && copyTaskCount <= 100
      && copySourceReady
      && notReadyAccountIds.length === 0
      && presetId
      && selectedPresetLaunchReady
      && copyConfigsValid,
  );
  const previewReadiness = copyPreviewReadiness(copyPreview);
  const previewValid = previewReadiness.usable;
  const previewSources = copyPreview
    ? copyPreview.sourceSnapshots.length > 0 ? copyPreview.sourceSnapshots : [copyPreview.sourceSnapshot]
    : [];
  const contentReady = launchMode === "copy" ? copyInputReady : Boolean(sheet && sheet.errors.length === 0 && sheet.rows.length > 0);
  const canSave = Boolean(canManageLaunchPresets && canDispatchLaunch && selectedAccountIds.length > 0 && notReadyAccountIds.length === 0 && copySourceReady && presetId && selectedPresetLaunchReady && contentReady);
  const publishBlockers = [
    !canManageLaunchPresets ? "当前角色缺少创建计划所需的 launch:manage 权限。" : null,
    !canDispatchLaunch ? "当前角色缺少执行创建所需的 ads:operate 权限。" : null,
    selectedAccountIds.length === 0 ? "请选择至少一个已接入的发布账户。" : null,
    notReadyAccountIds.length > 0 ? "所选账户连接异常，请先在用户管理重新完成接入。" : null,
    !presetId ? "请选择广告预设。" : null,
    presetId && !selectedPresetLaunchReady ? "当前预设参数映射尚未完成，请先在高级自定义中补全。" : null,
    launchMode !== "copy" && !sheet ? "请导入创建信息表。" : null,
    launchMode !== "copy" && sheet && sheet.errors.length > 0 ? "请先修正导入表错误。" : null,
    launchMode === "copy" && sourceAdGroupIds.length === 0 ? "请选择至少一个源广告组。" : null,
    launchMode === "copy" && !copySourceReady ? "源账户缺少广告读取能力，请重新检测接入。" : null,
    launchMode === "copy" && !copyConfigsValid ? "请完整填写每个目标账户的创建数量、预算、出价和创建时间。" : null,
    launchMode === "copy" && copyTaskCount > 100 ? "单次迁移最多创建 100 个广告组，请分批操作。" : null,
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
    const nextPlanItems = Object.fromEntries(itemLists);
    if (!terminalPlanNotificationsReady.current) {
      for (const plan of nextPlans) {
        if (["completed", "blocked", "cancelled"].includes(plan.status)) notifiedTerminalPlanIds.current.add(plan.id);
      }
      terminalPlanNotificationsReady.current = true;
    } else {
      for (const plan of nextPlans) {
        if (!["completed", "blocked"].includes(plan.status) || notifiedTerminalPlanIds.current.has(plan.id)) continue;
        notifiedTerminalPlanIds.current.add(plan.id);
        const summary = summarizeLaunchOutcomeToast(nextPlanItems[plan.id] ?? []);
        toast(summary.message, summary.tone);
      }
    }
    setPlanItems(nextPlanItems);
    setPresetId((current) => current && nextPresets.some((item) => item.id === current) ? current : (nextPresets[0]?.id ?? ""));
    onError(null);
  };
  const recoverLaunchAccount = async (
    accountId: string,
    access: AccountAccessStatus | null,
  ) => {
    if (!access || access.recovery === "connect") {
      onManageConnection?.(accountId);
      return;
    }
    const state = connectionStates.find((item) => item.accountId === accountId);
    const connection = connections[accountId] ?? state?.connection;
    if (!connection) {
      onManageConnection?.(accountId);
      return;
    }
    setRecoveringAccountIds((current) => [...new Set([...current, accountId])]);
    onError(null);
    try {
      if (access.recovery === "recheck") {
        const checked = await api.testConnection(accountId, connection.kind);
        if (checked.status !== "ready") {
          throw new Error(checked.lastMessage || "本地凭据重新检测失败，请重新接入。");
        }
      } else if (access.recovery === "sync") {
        await api.syncReadOnly(accountId, connection.kind);
      }
      await onConnectionStatesChanged?.();
      await load();
      toast("账户状态已恢复，当前选择已保留", "success");
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setRecoveringAccountIds((current) => current.filter((id) => id !== accountId));
    }
  };
  const refreshProgress = async () => {
    const [nextPlans, queuedPlanIds] = await Promise.all([
      api.getLaunchPlans(),
      api.getQueuedLaunchPlanIds(),
    ]);
    const idsToRefresh = [...new Set([...queuedPlanIds, ...activePlanIds])];
    const itemLists = await Promise.all(idsToRefresh.map(async (planId) => [planId, await api.getLaunchPlanItems(planId)] as const));
    const refreshedItems = Object.fromEntries(itemLists);
    setPlans(nextPlans);
    setActivePlanIds(queuedPlanIds);
    setPlanItems((current) => ({ ...current, ...refreshedItems }));
    for (const plan of nextPlans) {
      if (!["completed", "blocked"].includes(plan.status) || notifiedTerminalPlanIds.current.has(plan.id)) continue;
      notifiedTerminalPlanIds.current.add(plan.id);
      const summary = summarizeLaunchOutcomeToast(refreshedItems[plan.id] ?? planItems[plan.id] ?? []);
      toast(summary.message, summary.tone);
    }
  };
  loadRef.current = refreshProgress;
  useEffect(() => { void load().catch((cause) => onError(messageOf(cause))); }, [onError]);
  useEffect(() => {
    const poller = createLaunchProgressPoller(() => {
      void loadRef.current().catch((cause) => onError(messageOf(cause)));
    });
    poller.reconcile(activePlanIds);
    return () => poller.stop();
  }, [activePlanIds.join("|"), onError]);
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
    setCopyTargetConfigs((current) => current.filter((config) =>
      targets.some((account) => account.id === config.accountId)
        && config.accountId !== sourceAccountId,
    ));
  }, [launchMode, preferredAccountId, sourceAccountId, sourceAccounts, targets]);
  useEffect(() => {
    if (launchMode !== "copy" || !sourceAccountId) {
      setSourceAdGroups([]);
      setSourceAdGroupIds([]);
      return;
    }
    void api.getManagedEntities(sourceAccountId)
      .then((entities) => {
        const groups = buildSourceAdGroupOptions(entities);
        setSourceAdGroups(groups);
        setSourceAdGroupIds((current) => current.filter((id) => groups.some((group) => group.adGroupId === id)));
      })
      .catch((cause) => onError(messageOf(cause)));
  }, [launchMode, onError, sourceAccountId]);
  useEffect(() => {
    setCopyPreview(null);
  }, [launchMode, presetId, sheet, sourceAccountId, sourceAdGroupIds, targetIds, copyTargetConfigs]);
  useEffect(() => {
    setSheet(null);
    setFileName("");
    if (fileInput.current) fileInput.current.value = "";
    if (launchMode !== "copy") setCopyTargetConfigs([]);
  }, [launchMode]);
  useEffect(() => {
    if (!copyPreview) {
      setPreviewSecondsLeft(0);
      return;
    }
    const update = () => setPreviewSecondsLeft(Math.max(0, Math.ceil((new Date(copyPreview.expiresAt).getTime() - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [copyPreview]);
  const importFile = async (file: File | undefined) => {
    if (!file || !selectedPreset) return;
    try {
      setBusy(true);
      const result = await readLaunchSpreadsheet(file, selectedPreset, {
        requireVideoCode: launchMode !== "copy",
      });
      setSheet(result);
      setPlanRequestId(crypto.randomUUID());
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
        startAtRule: saved.startAtRule,
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
    setPresetForm({ name: preset.name, region: preset.region, dailyBudget: preset.dailyBudget, campaignBudget: preset.campaignBudget ?? null, bid: preset.bid, startAt: preset.startAt, endAt: preset.endAt, startAtRule: preset.startAtRule ?? "absolute", initialStatus: preset.initialStatus, creationConfig: preset.creationConfig });
  };
  const updateCreationConfig = (patch: Partial<LaunchPresetInput["creationConfig"]>) => {
    setPresetForm((value) => ({ ...value, creationConfig: { ...(value.creationConfig ?? defaultCreationPresetConfig), ...patch } }));
  };
  const presetCreationConfig = CreationPresetConfigSchema.parse(presetForm.creationConfig ?? {});
  const presetBudgetMode = resolveConfiguredBudgetMode(presetCreationConfig);
  const advancedTemplateReadiness = getCreationTemplateReadiness(presetCreationConfig);
  const advancedExecutionReady = advancedTemplateReadiness.ready;
  const removePreset = async (id: string) => {
    if (!await confirm({ title: "删除广告预设？", message: "删除后无法恢复；已创建计划中的冻结配置不受影响。", confirmLabel: "确认删除", danger: true })) return;
    try { setBusy(true); await api.deleteLaunchPreset(id); await load(); onError(null); }
    catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const setTargetSelected = (accountId: string, selected: boolean) => {
    setTargetIds((current) => selected ? [...new Set([...current, accountId])].slice(0, 100) : current.filter((id) => id !== accountId));
    if (launchMode !== "copy") return;
    setCopyTargetConfigs((current) => selected
      ? current.some((item) => item.accountId === accountId) ? current : [...current, {
          accountId,
          quantity: 1,
          dailyBudget: selectedPreset?.dailyBudget ?? 100,
          bid: selectedPreset?.bid ?? null,
          initialStatus: "enabled",
          startAtRule: "absolute",
          startAt: null,
        }]
      : current.filter((item) => item.accountId !== accountId));
  };
  const setSourceGroupSelected = (adGroupId: string, selected: boolean) => {
    setSourceAdGroupIds((current) => selected
      ? [...new Set([...current, adGroupId])].slice(0, 20)
      : current.filter((id) => id !== adGroupId));
  };
  const updateTargetConfig = (accountId: string, patch: Partial<LaunchMigrationTargetConfig>) => {
    const normalizedPatch = patch.startAtRule === "absolute" && !("startAt" in patch)
      ? { ...patch, startAt: new Date(Date.now() + 60 * 60_000).toISOString() }
      : patch;
    setCopyTargetConfigs((current) => current.map((item) => item.accountId === accountId ? { ...item, ...normalizedPatch } : item));
  };
  const ensureCopyPreview = async (): Promise<LaunchCopyPreviewRecord> => {
    if (launchMode !== "copy" || !copyInputReady) {
      throw new Error("请先完成源广告组、目标账户和迁移配置。");
    }
    if (previewValid && copyPreview) return copyPreview;
    if (copyPreviewInFlight.current) {
      throw new Error("迁移检查正在进行，请稍后重试。");
    }
    copyPreviewInFlight.current = true;
    try {
      const preview = await api.createLaunchCopyPreview({
        sourceAccountId,
        sourceAdGroupId: sourceAdGroupIds[0]!,
        sourceAdGroupIds,
        targetAccountIds: targetIds,
        launchPresetId: presetId,
        launchRows: [],
        targetConfigs: copyTargetConfigs,
      });
      setCopyPreview(preview);
      const readiness = copyPreviewReadiness(preview);
      if (!readiness.usable) {
        throw new Error(readiness.blocker ?? "原帖检查没有产出可迁移内容。");
      }
      return preview;
    } finally {
      copyPreviewInFlight.current = false;
    }
  };
  const savePlan = async () => {
    if (!canSave || (launchMode !== "copy" && !sheet)) return;
    try {
      setBusy(true);
      setExecutionFeedback(null);
      if (launchMode === "expand" || launchMode === "campaign-copy") return;
      const planPreview = launchMode === "copy"
        ? await ensureCopyPreview()
        : null;
      const plan = await api.createLaunchPlan({
        clientRequestId: planRequestId,
        mode: launchMode,
        sourceAccountId: launchMode === "copy" ? sourceAccountId : selectedAccountIds[0] ?? sourceAccountId,
        sourceAdGroupId: launchMode === "copy" ? sourceAdGroupIds[0] ?? null : null,
        sourceAdGroupIds: launchMode === "copy" ? sourceAdGroupIds : [],
        copyPreviewId: planPreview?.id ?? null,
        targetAccountIds: selectedAccountIds,
        launchPresetId: presetId,
        launchRows: planPreview?.launchRows ?? sheet?.rows ?? [],
        copyTargetConfigs: launchMode === "copy" ? copyTargetConfigs : [],
      });
      if (dispatchMode === "immediate") {
        setActivePlanIds((current) => [...new Set([...current, plan.id])]);
        setExecutionFeedback({
          tone: "warning",
          title: "正在创建广告组",
          lines: ["系统正按账户逐项执行；下方结果区会显示校验、草稿、发布和回读阶段。"],
        });
        const execution = await api.executeLaunchPlan(plan.id);
        setExecutionFeedback(summarizeExecution(execution, accounts));
        notifiedTerminalPlanIds.current.add(plan.id);
        const summary = summarizeLaunchOutcomeToast(execution.results);
        toast(summary.message, summary.tone);
      } else {
        await api.queueLaunchPlan(plan.id);
        setActivePlanIds((current) => [...new Set([...current, plan.id])]);
        setExecutionFeedback({ tone: "warning", title: "已加入后台创建队列", lines: ["页面将持续刷新逐项状态；关闭本页不会中断已领取的任务。"] });
      }
      setSheet(null); setFileName(""); setTargetIds([]); setCopyPreview(null); setPlanRequestId(crypto.randomUUID());
      if (fileInput.current) fileInput.current.value = "";
      await load(); onError(null);
    } catch (cause) {
      setExecutionFeedback(null);
      onError(messageOf(cause));
    }
    finally { setBusy(false); }
  };
  const cancelPlan = async (planId: string) => {
    if (!await confirm({ title: "取消创建计划？", message: "尚未领取的任务会被取消；正在执行的任务不会被强制中断。", confirmLabel: "确认取消", danger: true })) return;
    try { setBusy(true); await api.cancelLaunchPlan(planId); await load(); onError(null); }
    catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const retryPlanItem = async (planId: string, itemId: string) => {
    try {
      setBusy(true);
      const execution = await api.retryLaunchPlanItem(planId, itemId);
      setExecutionFeedback(summarizeExecution(execution, accounts));
      notifiedTerminalPlanIds.current.add(planId);
      const summary = summarizeLaunchOutcomeToast(execution.results);
      toast(summary.message, summary.tone);
      await load();
      onError(null);
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  return <section className="page-stack launch-page">
    <div className="panel launch-hero"><span><Rocket size={28} /></span><div><span className="eyebrow">多账户投放</span><h2>批量创建广告</h2><p>预设统一覆盖预算、出价、地区与创建时间；表格只填系列、广告组、视频与产品 URL。</p></div><span className={selectedPresetLaunchReady ? "status active" : "status warning"}>{selectedPresetLaunchReady ? "创建参数已就绪" : "创建参数待完善"}</span></div>

    <nav aria-label="广告创建流程" className="launch-workflow-steps">
      <span className="active"><b>1</b><strong>选择方式</strong><small>确定创建范围</small></span>
      <span className={selectedAccountIds.length > 0 ? "complete" : ""}><b>2</b><strong>账户与预设</strong><small>配置发布上下文</small></span>
      <span className={launchMode === "copy" ? previewValid ? "complete" : "" : sheet?.errors.length === 0 && sheet.rows.length ? "complete" : ""}><b>3</b><strong>{launchMode === "copy" ? "原帖检查" : "导入校验"}</strong><small>核对创建内容</small></span>
      <span className={canSave ? "ready" : ""}><b>4</b><strong>执行发布</strong><small>进入后台队列</small></span>
    </nav>

    <div className="launch-workbench">
      <aside className="launch-mode-sidebar">

    <div className="panel launch-mode-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>选择创建方式</h2></div></div></div><div className="launch-mode-options">{([['single','单账户批量创建','向一个账户批量创建广告'],['multi','多账户同时发布','共享视频代码到 Post ID 映射，各账户仅使用自己的 Cookie 会话'],['copy','跨账户复制迁移','用稳定 ID 冻结源结构，并在目标账户重新创建'],['expand','一键扩组','按账户勾选广告组，为每个源组各复制 N 个新组'],['campaign-copy','系列复制','把整个推广系列复制成多个新系列，并决定每个系列放几个广告组']] as const).map(([mode,title,description]) => <button className={launchMode === mode ? 'active' : ''} key={mode} onClick={() => { setLaunchMode(mode); setCopyPreview(null); if (mode === 'single') setTargetIds([]); }} type="button"><strong>{title}</strong><span>{description}</span></button>)}</div></div>

        {launchMode === "expand" && <div className="expand-preset-sidebar-host" ref={(node) => setExpandPresetHost(node)} />}

        <div className="launch-sidebar-summary">
          <span><small>已选账户</small><strong>{selectedAccountIds.length}</strong></span>
          <span><small>导入条目</small><strong>{sheet?.rows.length ?? 0}</strong></span>
          <span><small>待处理计划</small><strong>{activePlanIds.length}</strong></span>
        </div>
      </aside>

      <main className="launch-workspace">
        {launchMode === "campaign-copy" ? <CopyCampaignPanel accounts={accounts} busy={busy} onError={onError} /> : launchMode === "expand" ? <ExpandGroupsPanel accounts={accounts} connectionStates={connectionStates} onConnectionStatesChanged={onConnectionStatesChanged} onManageConnection={onManageConnection} onError={onError} presetHost={expandPresetHost} /> : <>

    <div className="panel launch-scope-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>发布账户</h2><p>{launchMode === "single" ? "选择一个账户，本批表格将在该账户中从零创建。" : launchMode === "copy" ? "以源广告组为迁移载体，为每个目标账户独立配置创建数量和投放参数。" : "选择多个账户；同名系列复用，广告组与广告均创建新 ID。"}</p></div></div><button className="secondary-button compact-button" disabled={busy} onClick={() => void load().catch((cause) => onError(messageOf(cause)))} title="只重新读取已保存的接入状态；如需拉取广告数据，请到用户管理执行只读同步。" type="button"><RefreshCcw size={14} /> 重新读取状态</button></div><div className="launch-account-summary">
      <div className="launch-account-summary-head"><div><strong>账户创建就绪状态</strong><span>{accounts.length ? `${targets.length} 个可发布 · ${unreadyAccountCount} 个待完善` : "尚未添加账户"}</span></div><button className="secondary-button compact-button" onClick={() => { window.location.hash = "#users"; }} type="button"><Settings2 size={14} /> 前往用户管理</button></div>
      {accounts.length === 0 ? <p className="launch-account-empty">先在“用户管理”添加广告账户并完成接入，随后可回到此处选择发布账户。</p> : <div className="launch-account-readiness-grid">{accountReadiness.map(({ account, checks, ready, access }) => {
        const recovering = recoveringAccountIds.includes(account.id);
        return <article className={ready ? "launch-account-readiness ready" : "launch-account-readiness"} key={account.id}>
          <header><div><strong>{account.displayName}</strong><span>{account.providerKind === "cookie" ? "Cookie 接入" : "Marketing API"}</span></div><em className={ready ? "status active" : "status warning"}>{ready ? "可发布" : "待完善"}</em></header>
          <div>{checks.map((check) => <span className={check.passed ? "passed" : "missing"} key={check.label}>{check.passed ? <CircleCheck size={14} /> : <CircleX size={14} />}{check.label}</span>)}</div>
          {!ready && <footer className="launch-account-recovery"><small>{access?.blockers[0] ?? "账户接入或创建能力尚未就绪。"}</small><button className="secondary-button compact-button" disabled={recovering} onClick={() => void recoverLaunchAccount(account.id, access)} type="button">{recovering ? <><RefreshCcw className="spin" size={13} />检测中</> : access?.recovery === "sync" ? "立即同步" : access?.recovery === "connect" ? "前往账户接入" : "用本地凭据重新检测"}</button></footer>}
        </article>;
      })}</div>}
    </div><div className="form-grid">
      {targets.length === 0 ? <div className="launch-target-empty"><CircleX size={18} /><div><strong>暂时没有可发布账户</strong><span>人工真实创建只要求接入检测通过且具备创建权限；自动化开关不阻止手动发布。</span></div><button className="secondary-button compact-button" onClick={() => { window.location.hash = "#users"; }} type="button">去完善账户</button></div> : <>
        {launchMode === "single" && <label className="field"><span>创建账户</span><select value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}><option value="">请选择</option>{sourceAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select><small>仅显示已授权创建能力的账户。</small></label>}
        {launchMode === "copy" && <><label className="field"><span>源广告账户</span><select value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}><option value="">请选择</option>{sourceAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select><small>源账户需要具备推广系列和广告组读取能力。</small></label><div className="field wide source-ad-group-picker"><span>源广告组（可多选，最多 20 个）</span><div className="target-account-toolbar"><input placeholder="搜索系列名、广告组名或 ID" value={sourceGroupQuery} onChange={(event) => setSourceGroupQuery(event.target.value)} /><span>已选 {sourceAdGroupIds.length} / {sourceAdGroups.length}</span><button className="secondary-button compact-button" onClick={() => visibleSourceAdGroups.forEach((group) => setSourceGroupSelected(group.adGroupId, true))} type="button">全选当前结果</button><button className="secondary-button compact-button" onClick={() => setSourceAdGroupIds([])} type="button">清空</button></div><div className="source-ad-group-options">{visibleSourceAdGroups.length === 0 ? <p className="target-account-empty">没有匹配的当前广告组。</p> : visibleSourceAdGroups.map((group) => <label key={group.adGroupId}><input checked={sourceAdGroupIds.includes(group.adGroupId)} disabled={!sourceAdGroupIds.includes(group.adGroupId) && sourceAdGroupIds.length >= 20} onChange={(event) => setSourceGroupSelected(group.adGroupId, event.target.checked)} type="checkbox" /><span>{group.campaignName} / {group.name}</span><small>ID …{group.adGroupId.slice(-6)} · {new Date(group.syncedAt).toLocaleString("zh-CN", { hour12: false })}</small></label>)}</div><small>列表右下角可拖动调整高度；每个源组都会按目标账户数量分别创建。</small></div></>}
        {launchMode !== "single" && <div className="field wide target-account-selector"><span>{launchMode === "copy" ? "目标账户（必须已绑定同一个 TikTok 身份）" : "发布账户（可多选）"}</span><div className="target-account-toolbar"><input aria-label="搜索可用发布账户" placeholder="搜索已接入账户" value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} /><span>已选 {targetIds.length} / {availableTargets.length}</span><button className="secondary-button compact-button" onClick={() => visibleTargets.forEach((account) => setTargetSelected(account.id, true))} type="button">全选当前结果</button><button className="secondary-button compact-button" onClick={() => { setTargetIds([]); setCopyTargetConfigs([]); }} type="button">清空</button></div><div className="target-account-grid">{visibleTargets.length === 0 ? <p className="target-account-empty">没有匹配的可用账户。</p> : visibleTargets.map((account) => <label key={account.id}><input checked={targetIds.includes(account.id)} onChange={(event) => setTargetSelected(account.id, event.target.checked)} type="checkbox" /><span>{account.displayName}</span><small>已接入 · {account.providerKind === "cookie" ? "Cookie" : "Marketing API"}</small></label>)}</div>{launchMode === "copy" && copyTargetConfigs.length > 0 && <div className="migration-target-configs">{copyTargetConfigs.map((config) => { const account = accounts.find((item) => item.id === config.accountId); return <article key={config.accountId}><header><strong>{account?.displayName ?? config.accountId}</strong><small>账户时区：{account?.timezone ?? "UTC"}</small></header><div className="form-grid"><label className="field"><span>创建广告组数量</span><input min="1" max="20" type="number" value={config.quantity} onChange={(event) => updateTargetConfig(config.accountId, { quantity: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })} /></label><label className="field"><span>每日预算</span><input min="0.01" step="0.01" type="number" value={config.dailyBudget} onChange={(event) => updateTargetConfig(config.accountId, { dailyBudget: Number(event.target.value) })} /></label><label className="field"><span>出价（留空为自动）</span><input min="0" step="0.01" type="number" value={config.bid ?? ""} onChange={(event) => updateTargetConfig(config.accountId, { bid: event.target.value === "" ? null : Number(event.target.value) })} /></label><label className="field"><span>创建后状态</span><select value={config.initialStatus} onChange={(event) => updateTargetConfig(config.accountId, { initialStatus: event.target.value as "enabled" | "disabled" })}><option value="enabled">开启（默认）</option><option value="disabled">关闭</option></select><small>立即或定时创建均默认投放，无需创建后手动开启。</small></label><label className="field"><span>创建时间</span><select value={config.startAtRule === "absolute" ? (config.startAt ? "custom" : "immediate") : config.startAtRule} onChange={(event) => { const value = event.target.value; updateTargetConfig(config.accountId, value === "immediate" ? { startAtRule: "absolute", startAt: null } : value === "custom" ? { startAtRule: "absolute" } : { startAtRule: value as "next-six" | "tonight", startAt: null }); }}><option value="immediate">立即投放</option><option value="next-six">最近未来 06:00</option><option value="tonight">当天 24:00</option><option value="custom">自定义定时</option></select>{config.startAtRule === "absolute" && config.startAt !== null && <input type="datetime-local" value={toLocalInput(config.startAt)} onChange={(event) => updateTargetConfig(config.accountId, { startAt: toIso(event.target.value) })} />}<small>06:00 按账户时区取下一个尚未到达的早上。</small></label></div></article>; })}</div>}</div>}
      </>}
    </div>{launchMode === "copy" && selectedSourceGroups.length > 0 && <div className="creation-template-note"><strong>已选 {selectedSourceGroups.length} 个源广告组</strong><span>{selectedSourceGroups.map((group) => `${group.campaignName} / ${group.name}`).join("；")}</span></div>}</div>

    <div className="panel launch-readiness-panel"><div className="panel-heading"><div><span className="panel-icon"><CheckCircle2 size={18} /></span><div><h2>创建检查</h2><p>账户、源广告组和目标配置通过后即可发布；原帖会在发布时自动读取并核对。</p></div></div><span className={canSave ? "status active" : "status warning"}>{canSave ? "可创建" : "待完善"}</span></div><div className="sheet-rule-grid">
      <article><strong>数据读取与启停</strong><span>{selectedAccountIds.length === 0 ? "请选择要发布的账户。" : notReadyAccountIds.length === 0 ? `已选 ${selectedAccountIds.length} 个账户均已通过连接检测。` : `有 ${notReadyAccountIds.length} 个已选账户连接异常。`}</span></article>
      <article><strong>{launchMode === "copy" ? "原帖可用性" : "视频素材"}</strong><span>{launchMode === "copy" ? "按 TikTok item_id 核对每个目标账户；缺少任一原帖都会在发布前阻断。" : "普通创建继续使用表格视频代码及预设中的 TikTok Post 映射。"}</span></article>
      <article><strong>广告预设</strong><span>{selectedPreset ? `当前使用“${selectedPreset.name}”` : "请选择广告预设。"}</span></article>
      <article><strong>创建功能</strong><span>{selectedAccountIds.length === 0 ? "请选择发布账户。" : notReadyAccountIds.length > 0 ? "所选账户的连接或创建能力尚未就绪。" : selectedPresetLaunchReady ? "当前预设参数完整，日常投放无需重复填写内部字段。" : "当前预设参数不完整，不能发起创建。"}</span></article>
      <article><strong>{launchMode === "copy" ? "迁移确认" : "导入信息"}</strong><span>{launchMode === "copy" ? previewValid ? `原帖和逐账户配置已冻结，共 ${copyPreview!.items.length} 个广告组。` : "点击迁移后自动读取并核对源广告组和目标账户原帖。" : sheet?.errors.length === 0 && sheet.rows.length ? `本次导入共创建 ${importedCampaignCount} 个系列（同名跳过），${sheet.rows.length} 个广告组。` : "导入表只需填写系列名称、广告组名称、视频代码和产品 URL。"}</span></article>
    </div></div>

    {launchMode !== "copy" && <div className="panel launch-preset-panel"><div className="panel-heading"><div><span className="panel-icon"><Pencil size={18} /></span><div><h2>广告预设模板</h2><p>预算、出价、创建时间和初始状态在此统一设置；保存后可复用。</p></div></div></div><div className="form-grid">
      <label className="field"><span>预设名称</span><input value={presetForm.name} onChange={(event) => setPresetForm((value) => ({ ...value, name: event.target.value }))} /></label>
      <label className="field"><span>投放地区</span><input placeholder="例如：US、美国、US/CA" value={presetForm.region} onChange={(event) => setPresetForm((value) => ({ ...value, region: event.target.value }))} /></label>
      <div className="field budget-mode-field"><span>预算模式</span><div className="budget-mode-switch" role="group" aria-label="预算模式">
        <button aria-pressed={presetBudgetMode === "ad-group"} className={presetBudgetMode === "ad-group" ? "active" : ""} onClick={() => updateCreationConfig({ budgetMode: "ad-group" })} type="button">广告组预算</button>
        <button aria-pressed={presetBudgetMode === "campaign"} className={presetBudgetMode === "campaign" ? "active" : ""} onClick={() => updateCreationConfig({ budgetMode: "campaign" })} type="button">系列预算</button>
      </div><small>{presetBudgetMode === "campaign" ? "预算由推广系列统一持有并在广告组之间自动分配；广告组不再单独设预算。" : "每个广告组各自持有日预算，推广系列不设预算。"}</small></div>
      {presetBudgetMode === "campaign"
        ? <label className="field"><span>系列日预算</span><input min="0.01" step="0.01" type="number" value={presetForm.campaignBudget ?? ""} onChange={(event) => setPresetForm((value) => ({ ...value, campaignBudget: event.target.value === "" ? null : Number(event.target.value) }))} /><small>同一个推广系列下的所有广告组共用这一份预算。</small></label>
        : <label className="field"><span>广告组日预算</span><input min="0.01" step="0.01" type="number" value={presetForm.dailyBudget} onChange={(event) => setPresetForm((value) => ({ ...value, dailyBudget: Number(event.target.value) }))} /></label>}
      <label className="field"><span>出价（留空为自动）</span><input min="0" step="0.01" type="number" value={presetForm.bid ?? ""} onChange={(event) => setPresetForm((value) => ({ ...value, bid: event.target.value === "" ? null : Number(event.target.value) }))} /></label>
      <label className="field"><span>创建时间（留空为立即）</span><input type="datetime-local" value={presetForm.startAtRule === "absolute" ? toLocalInput(presetForm.startAt) : ""} onChange={(event) => setPresetForm((value) => ({ ...value, startAtRule: "absolute", startAt: toIso(event.target.value) }))} /><span className="quick-time-actions"><button className={presetForm.startAtRule === "tonight" ? "active" : ""} onClick={() => setPresetForm((value) => ({ ...value, startAtRule: "tonight", startAt: null }))} type="button">当天 24:00</button><button className={presetForm.startAtRule === "tomorrow-morning" ? "active" : ""} onClick={() => setPresetForm((value) => ({ ...value, startAtRule: "tomorrow-morning", startAt: null }))} type="button">次日 06:00</button></span>{presetForm.startAtRule !== "absolute" && <small className="preset-rule-hint">已设为{presetForm.startAtRule === "tonight" ? "当天 24:00" : "次日 06:00"}，随日期自动变动，无需每天修改。</small>}</label>
      <label className="field"><span>初始状态</span><select value={presetForm.initialStatus} onChange={(event) => setPresetForm((value) => ({ ...value, initialStatus: event.target.value as LaunchPresetInput["initialStatus"] }))}><option value="disabled">关闭</option><option value="enabled">开启</option></select></label>
    </div><div className="creation-template-note"><strong>内置创建协议</strong><span>用户无需再抓取创建接口；两条 cURL 提供当前账户会话，广告预设负责预算、地区、出价和时间等业务参数。</span></div>{!canManageLaunchPresets && <div className="preset-save-feedback warning"><strong>当前账号无预设管理权限</strong><span>登录角色为“{auth.status.user?.role ?? "未知"}”，无法保存广告预设；请切换至开发者、管理员或操作员账号。</span></div>}{presetFeedback && <div className={`preset-save-feedback ${presetFeedback.tone}`}><strong>{presetFeedback.title}</strong><span>{presetFeedback.lines[0]}</span></div>}<div className="form-actions"><button className="primary-button" disabled={busy || !canManageLaunchPresets} onClick={() => void savePreset()} title={canManageLaunchPresets ? undefined : "需要 launch:manage 权限"} type="button">{editingPresetId ? "更新预设" : "新建预设"}</button>{editingPresetId && <button className="secondary-button" onClick={() => { setEditingPresetId(null); setPresetForm(freshPreset()); setPresetFeedback(null); }} type="button">取消编辑</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>预设</th><th>地区</th><th>预算模式</th><th>预算</th><th>出价</th><th>创建时间</th><th>初始状态</th><th>操作</th></tr></thead><tbody>{presets.map((preset) => { const mode = resolveConfiguredBudgetMode(preset.creationConfig); return <tr key={preset.id}><td>{preset.name}</td><td>{preset.region}</td><td>{mode === "campaign" ? "系列预算" : "广告组预算"}</td><td>{mode === "campaign" ? preset.campaignBudget ?? "未设置" : preset.dailyBudget}</td><td>{preset.bid ?? "自动"}</td><td>{preset.startAtRule === "tonight" ? "当天 24:00（每日自动）" : preset.startAtRule === "tomorrow-morning" ? "次日 06:00（每日自动）" : preset.startAt ? new Date(preset.startAt).toLocaleString() : "立即"}</td><td>{preset.initialStatus === "enabled" ? "开启" : "关闭"}</td><td><button disabled={busy} onClick={() => editPreset(preset)} type="button">编辑</button> <button disabled={busy} onClick={() => void removePreset(preset.id)} type="button">删除</button></td></tr>; })}</tbody></table></div>
    </div>}

    <details className="panel creation-config-panel"><summary><span><Settings2 size={18} /></span><div><strong>高级自定义参数</strong><small>真实创建映射随预设保存；日常投放无需展开</small></div><em className={advancedExecutionReady ? "status active" : "status warning"}>{advancedExecutionReady ? "参数映射完整" : "参数映射不完整"}</em></summary><div className="creation-config-body"><div className="creation-template-note"><strong>{advancedExecutionReady ? "当前预设参数映射完整" : "当前预设尚未完成参数映射"}</strong><span>{advancedExecutionReady ? "创建时使用当前账户 Cookie 会话并覆盖下列业务参数。" : "请按参数对照补全真实创建需要的业务映射；账户内部系列 ID 不作为跨账户必填项。"}</span></div><div className="creation-config-reference"><div><strong>参数</strong><strong>来源 / 获取位置</strong></div><div><span>营销目标、购买方式、预算方式</span><span>TikTok Ads Manager 新建推广系列页</span></div><div><span>计费方式、优化目标、转化事件、像素</span><span>广告组设置与事件管理器</span></div><div><span>广告身份、行动号召</span><span>广告创建页的身份与创意设置</span></div><div><span>地区与版位代码</span><span>广告组定向设置</span></div></div><button className="secondary-button creation-guide-button" onClick={() => { window.location.hash = "#manual"; }} type="button">查看完整参数对照与获取方式</button><div className="form-grid">
      <label className="field"><span>营销目标</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.objectiveType ?? ""} onChange={(event) => updateCreationConfig({ objectiveType: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>购买方式</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.buyingType ?? ""} onChange={(event) => updateCreationConfig({ buyingType: nullableInteger(event.target.value) })} /></label>
      {/* 系列/广告组的 budget_mode 由上方「预算模式」开关派生，不再手填原始数字：
          手填的数字曾经只改 budget_mode 而不带金额，会发出畸形表单。 */}
      <label className="field"><span>计费方式</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.pricing ?? ""} onChange={(event) => updateCreationConfig({ pricing: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>优化目标</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.optimizeGoal ?? ""} onChange={(event) => updateCreationConfig({ optimizeGoal: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>转化事件</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.externalAction ?? ""} onChange={(event) => updateCreationConfig({ externalAction: nullableInteger(event.target.value) })} /></label>
      <label className="field"><span>广告身份类型</span><input inputMode="numeric" placeholder="例如 1" value={presetCreationConfig.identityType ?? ""} onChange={(event) => updateCreationConfig({ identityType: nullableInteger(event.target.value) })} /></label>
      {presetCreationConfig.identityType !== 0 && <label className="field"><span>广告身份 ID</span><input placeholder="从账户后台复制" value={presetCreationConfig.identityId ?? ""} onChange={(event) => updateCreationConfig({ identityId: event.target.value || null })} /></label>}
      <label className="field"><span>行动号召 ID</span><input placeholder="从账户后台复制" value={presetCreationConfig.callToActionId ?? ""} onChange={(event) => updateCreationConfig({ callToActionId: event.target.value || null })} /></label>
      <label className="field"><span>像素 ID</span><input placeholder="从账户后台复制" value={presetCreationConfig.pixelId ?? ""} onChange={(event) => updateCreationConfig({ pixelId: event.target.value || null })} /></label>
      <label className="field"><span>地区代码（逗号分隔）</span><input inputMode="numeric" placeholder="例如 840,124" value={(presetCreationConfig.countryCodes ?? []).join(",")} onChange={(event) => updateCreationConfig({ countryCodes: parseIntegerList(event.target.value) })} /></label>
      <label className="field"><span>版位代码（逗号分隔）</span><input inputMode="numeric" placeholder="例如 3000" value={(presetCreationConfig.placementIds ?? []).join(",")} onChange={(event) => updateCreationConfig({ placementIds: parseIntegerList(event.target.value) })} /></label>
      <label className="field wide"><span>普通创建 TikTok Post 映射（视频代码 | Post ID）</span><textarea placeholder="仅普通上传/新建流程使用" value={formatVideoPostMappings(presetCreationConfig.videoPostMappings)} onChange={(event) => updateCreationConfig({ videoPostMappings: parseVideoPostMappings(event.target.value) })} /><small>原帖迁移不会读取此映射，也不会回退到视频代码或上传流程。</small></label>
    </div><div className="form-actions"><button className="primary-button" disabled={busy || !canManageLaunchPresets || !advancedExecutionReady} onClick={() => void savePreset()} title={advancedExecutionReady ? undefined : "必须完成真实创建参数映射后才能保存"} type="button">保存高级自定义</button></div></div></details>

    <div className="panel launch-sheet-panel"><div className="panel-heading"><div><span className="panel-icon"><FileSpreadsheet size={18} /></span><div><h2>{launchMode === "copy" ? "原帖迁移确认" : "导入创建信息"}</h2><p>{launchMode === "copy" ? "源广告组提供系列、广告组、产品 URL 和全部原帖；无需导入表格。" : "表格仅保留推广系列名称、广告组名称、视频代码和产品 URL。广告名称自动生成。"}</p></div></div>{launchMode !== "copy" && <button className="secondary-button" onClick={() => void downloadLaunchTemplate().catch((cause) => onError(messageOf(cause)))} type="button"><Download size={16} /> 下载模板</button>}</div>
      <div className="sheet-rule-grid"><article><strong>1. 选择广告预设</strong><span>{selectedPreset ? `当前：${selectedPreset.name} · ${selectedPreset.region}` : "请先选择预设。"}</span></article><article><strong>2. {launchMode === "copy" ? "配置目标账户" : "填写创建设置"}</strong><span>{launchMode === "copy" ? `已配置 ${copyTargetConfigs.length} 个账户，共创建 ${copyTaskCount} 个广告组。` : "填写系列名称、广告组名称、视频代码和产品 URL。"}</span></article><article><strong>3. {launchMode === "copy" ? "原帖自动读取" : "多视频代码"}</strong><span>{launchMode === "copy" ? "逐账户核对 item_id；目标账户必须绑定同一个 TikTok 身份。" : "同一单元格可用 `；`、`;` 或换行分隔多个代码，作为同一广告组的多个素材。"}</span></article><article><strong>4. 最终确认</strong><span>{launchMode === "copy" ? "点击迁移时自动读取并核对原帖，核对通过后进入创建队列。" : "广告名称自动生成后进入后台队列。"}</span></article></div>
      <label className="field" style={{ margin: "0 18px 12px" }}><span>本次使用的广告预设</span><select value={presetId} onChange={(event) => { setPresetId(event.target.value); setSheet(null); }}><option value="">请选择预设</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
      {selectedPreset && <div className="selected-preset-summary" aria-label="当前广告预设详情"><strong>{selectedPreset.name}</strong><div><span><small>地区</small>{selectedPreset.region}</span><span><small>每日预算</small>{selectedPreset.dailyBudget}</span><span><small>出价</small>{selectedPreset.bid ?? "自动"}</span><span><small>创建时间</small>{presetStartLabel(selectedPreset)}</span><span><small>预设初始状态</small>{selectedPreset.initialStatus === "enabled" ? "开启" : "关闭"}</span><span><small>创建参数</small>{selectedPresetLaunchReady ? "已就绪" : "待补全"}</span></div>{launchMode === "copy" && <p>原帖迁移的数量、预算、出价、时间和创建后状态，以上方每个目标账户的配置为准。</p>}</div>}
      {launchMode !== "copy" && <><button className="sheet-dropzone" disabled={busy || !selectedPreset} onClick={() => fileInput.current?.click()} type="button"><Upload size={22} /><strong>{fileName || "选择 .xlsx / .csv 文件"}</strong><span>{selectedPreset ? "导入不会立即创建广告。" : "请先选择广告预设。"}</span></button><input ref={fileInput} accept=".xlsx,.csv" hidden onChange={(event) => void importFile(event.target.files?.[0])} type="file" />{sheet && <div className="sheet-result"><div className="sheet-summary"><span className={sheet.errors.length === 0 ? "status active" : "status danger"}>{sheet.errors.length === 0 ? <CheckCircle2 size={14} /> : <X size={14} />}{sheet.errors.length === 0 ? `本次导入共创建 ${importedCampaignCount} 个系列（同名跳过），${sheet.rows.length} 个广告组` : `${sheet.errors.length} 个错误`}</span></div>{sheet.errors.length > 0 && <IssueList issues={sheet.errors} />}{sheet.rows.length > 0 && <div className="table-wrap"><table className="sheet-preview-table"><thead><tr><th>来源行</th><th>推广系列</th><th>广告组</th><th>视频代码</th><th>产品 URL</th><th>广告名称</th><th>预算</th><th>出价</th></tr></thead><tbody>{sheet.rows.slice(0, 100).map((row) => <tr key={`${row.rowNumber}-${row.videoCode}`}><td>{row.rowNumber}</td><td>{row.campaignName}</td><td>{row.adGroupName}</td><td>{row.videoCode}</td><td><small>{row.productUrl}</small></td><td>{row.adName}</td><td>{row.dailyBudget}</td><td>{row.bid ?? "自动"}</td></tr>)}</tbody></table></div>}</div>}</>}
      {copyPreview && <div className={previewValid ? "creation-template-note copy-preview-result migration-confirmation" : "sheet-issues warning copy-preview-result"}><strong>{previewValid ? `最终确认 · ${previewSources.length} 个源组 · ${previewSources.reduce((sum, source) => sum + source.posts.length, 0)} 帖 · ${copyPreview.items.length} 个广告组` : "原帖检查没有产出任何可创建的广告组"}</strong><span className="status">{previewSecondsLeft > 0 ? `原帖证据已冻结 · ${formatCountdown(previewSecondsLeft)}` : "原帖证据已过期，执行时会重新回读并逐条校验"}</span>{copyPreview.blockers.length > 0 && <><small>以下情况会在执行时跳过，其余广告组照常创建：</small><ul>{copyPreview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></>}{copyPreview.warnings.length > 0 && <ul>{copyPreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}{previewValid && <><div className="migration-source-list">{previewSources.map((source) => <div className="migration-source-summary" key={source.adGroupId}><strong>{source.campaignName} / {source.adGroupName}</strong><span>源广告组 ID：{source.adGroupId}</span><span>产品 URL：{source.productUrl ?? "未读取"}</span><span>原帖：{source.posts.length} 条</span><details><summary>查看前 5 条原帖</summary>{source.posts.slice(0, 5).map((post) => <small key={post.itemId}>{post.displayName ?? post.itemId} · item_id：{post.itemId}</small>)}</details></div>)}</div><div className="table-wrap"><table><thead><tr><th>目标账户</th><th>总数量</th><th>预算 / 出价</th><th>创建后状态</th><th>自动生成广告组名称</th><th>最终创建时间</th><th>原帖核对</th></tr></thead><tbody>{copyPreview.targetConfigs.map((config) => { const account = accounts.find((item) => item.id === config.accountId); const accountItems = copyPreview.items.filter((candidate) => candidate.accountId === config.accountId); const firstItem = accountItems[0]; const matchedPosts = new Map(accountItems.flatMap((item) => item.targetPostMapping.posts.map((post) => [post.itemId, post]))).size; const expectedPosts = previewSources.reduce((sum, source) => sum + source.posts.length, 0); return <tr key={config.accountId}><td>{account?.displayName ?? config.accountId}<small>{account?.timezone ?? "UTC"}</small></td><td>{config.quantity} × {previewSources.length} = {accountItems.length}</td><td>{config.dailyBudget} / {config.bid ?? "自动"}</td><td><span className={config.initialStatus === "enabled" ? "status active" : "status"}>{config.initialStatus === "enabled" ? "开启" : "关闭"}</span></td><td>{accountItems.slice(0, 4).map((item) => <small key={`${item.sourceSnapshot.adGroupId}-${item.itemIndex}`}>{item.launchRow.adGroupName}</small>)}{accountItems.length > 4 && <small>另 {accountItems.length - 4} 个…</small>}</td><td>{firstItem?.launchRow.startAt ? formatInTimeZone(firstItem.launchRow.startAt, account?.timezone ?? "UTC") : "立即"}</td><td>{matchedPosts}/{expectedPosts} 已匹配</td></tr>; })}</tbody></table></div></>}</div>}
      {publishBlockers.length > 0 && <div className="sheet-issues warning publish-blockers" id="publish-blockers"><strong>暂不能发布</strong><ul>{publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      <div className="launch-dispatch-mode"><strong>执行方式</strong><label><input checked={dispatchMode === "queue"} name="launch-dispatch-mode" onChange={() => setDispatchMode("queue")} type="radio" /> 后台队列（默认）</label><label><input checked={dispatchMode === "immediate"} name="launch-dispatch-mode" onChange={() => setDispatchMode("immediate")} type="radio" /> 立即执行（显示逐项阶段）</label></div><div className="form-actions"><button aria-describedby={publishBlockers.length > 0 ? "publish-blockers" : undefined} className="primary-button" disabled={busy || !canSave} title={publishBlockers[0]} onClick={() => void savePlan()} type="button">{dispatchMode === "immediate" ? "确认并立即创建" : launchMode === "single" ? "创建并发布" : launchMode === "copy" ? "确认配置并加入迁移队列" : "向所选账户发布"}{launchMode === "copy" ? `（${copyTaskCount} 个广告组）` : sheet?.rows.length ? `（${sheet.rows.length} 条 × ${selectedAccountIds.length} 个账户）` : ""}</button></div>
      {executionFeedback && <div className={executionFeedback.tone === "success" ? "creation-template-note" : `sheet-issues ${executionFeedback.tone}`}><strong>{executionFeedback.title}</strong><ul>{executionFeedback.lines.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul></div>}
    </div>

    <div className="panel table-panel">
      <div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>投放结果</h2><p>后台执行时会自动刷新逐项状态和当前阶段。</p></div></div></div>
      <div className="table-wrap"><table><thead><tr><th>创建内容</th><th>预设</th><th>计划任务</th><th>逐项实时状态</th><th>发布结果</th><th>操作</th></tr></thead><tbody>
        {plans.length === 0 ? <tr><td colSpan={6}>暂无投放计划。</td></tr> : plans.map((plan) => {
          const created = plan.executionResults.reduce((total, item) => total + item.createdCount, 0);
          const failed = plan.executionResults.reduce((total, item) => total + item.failedCount + item.unknownCount, 0);
          const verifying = plan.executionResults.reduce((total, item) => total + item.unknownCount, 0);
          const items = planItems[plan.id] ?? [];
          const failedItems = items.filter((item) => item.status === "failed");
          const verifyingItems = items.filter((item) => item.status === "unknown");
          const skippedMaterials = countSkippedMaterials(items);
          return <tr key={plan.id}>
            <td>{plan.sourceAdName}</td><td>{plan.presetName}</td><td>{plan.mode === "copy" ? `${items.length || plan.launchRows.length} 个广告组 / ${plan.targetAccountIds.length} 个账户` : `${plan.launchRows.length} 条 × ${plan.targetAccountIds.length} 个账户`}</td>
            <td>{items.length === 0 ? "尚未执行" : <div className="plan-item-progress">{items.map((item) => <small className={`status ${item.status === "succeeded" ? "active" : ["failed", "unknown"].includes(item.status) ? "danger" : "warning"}`} key={item.itemId}>{item.launchRow.adGroupName} · {launchItemStatusLabel(item.status)} · {launchPhaseLabel(item.phase)}</small>)}</div>}</td>
            <td><span className={`status ${plan.status === "completed" ? "active" : plan.status === "cancelled" ? "danger" : "warning"}`}>{plan.status === "completed" ? "已发布" : plan.status === "blocked" ? "未全部完成" : plan.status}</span>{plan.executionResults.length > 0 && <small className="plan-execution-summary">广告组成功 {created} · 失败 {failed}{verifying > 0 ? `（其中结果核验失败 ${verifying}）` : ""}</small>}{skippedMaterials > 0 && <small className="plan-execution-summary">素材失败 {skippedMaterials} 条，已跳过；不影响已创建的广告组。</small>}{plan.executionResults.map((item) => { const detail = summarizePlanAccountResult(item); return detail ? <small className={detail.tone === "danger" ? "plan-execution-error" : "plan-execution-summary"} key={item.accountId}>{accountNameById.get(item.accountId) ?? item.accountId}：{detail.text}</small> : null; })}</td>
            <td>{failedItems.map((item) => <button className="secondary-button compact-button" disabled={busy} key={item.itemId} onClick={() => void retryPlanItem(plan.id, item.itemId)} type="button">修正后重试 {item.launchRow.adGroupName}</button>)}{verifyingItems.map((item) => <button className="secondary-button compact-button" disabled={busy} key={item.itemId} onClick={() => void retryPlanItem(plan.id, item.itemId)} type="button">重新核验 {item.launchRow.adGroupName}</button>)}{["blocked", "draft"].includes(plan.status) && <button disabled={busy || items.some((item) => item.status === "running")} onClick={() => void cancelPlan(plan.id)} type="button"><Trash2 size={14} /> 取消</button>}</td>
          </tr>;
        })}
      </tbody></table></div>
    </div>

        </>}
      </main>
    </div>

  </section>;
}

function IssueList({ issues, tone = "danger" }: { issues: LaunchSheetImportResult["errors"]; tone?: "danger" | "warning" }) { return <div className={`sheet-issues ${tone}`}><strong>{tone === "danger" ? "需要修正" : "导入提示"}</strong><ul>{issues.slice(0, 20).map((issue, index) => <li key={`${issue.rowNumber}-${issue.field}-${index}`}>第 {issue.rowNumber} 行 · {issue.field}：{issue.message}</li>)}</ul></div>; }

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

/**
 * 复制预览能不能直接创建。
 *
 * 原帖检查不再阻断：跨账户复制最常见的阻断项是「目标账户没授权到某条原帖」，而
 * 没授权的本来就复制不过去，执行时那一条自己失败即可（系列批次已改为逐条隔离，
 * 不会拖垮同批其余广告组）。把人挡在创建之前、逼着反复重新生成预览没有意义。
 *
 * 预览过期同样不阻断：过期只说明冻结的原帖证据可能变旧，执行时会重新回读并逐条
 * 校验。真正还该拦的只剩一种——一条可创建的条目都没有，那样的计划没有意义。
 */
export function copyPreviewReadiness(
  preview: LaunchCopyPreviewRecord | null,
): { usable: boolean; blocker: string | null } {
  if (!preview) return { usable: false, blocker: "请先生成并核对复制差异预览。" };
  if (preview.items.length === 0) {
    return {
      usable: false,
      blocker: `原帖检查没有产出任何可创建的广告组：${preview.blockers[0] ?? "目标账户均无可用原帖。"}`,
    };
  }
  return { usable: true, blocker: null };
}

export function presetStartLabel(preset: LaunchPresetRecord): string {
  if (preset.startAtRule === "tonight") return "当天 24:00（每次自动计算）";
  if (preset.startAtRule === "tomorrow-morning") return "次日 06:00（每次自动计算）";
  return preset.startAt ? new Date(preset.startAt).toLocaleString("zh-CN") : "立即";
}
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : "创建广告操作失败。"; }

function copyDifferenceLabel(field: LaunchCopyPreviewRecord["items"][number]["differences"][number]["field"]): string {
  return {
    campaignName: "系列名称",
    adGroupName: "广告组名称",
    productUrl: "产品 URL",
  }[field];
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "已过期";
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatInTimeZone(value: string, timeZone: string): string {
  return `${new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))}（${timeZone}）`;
}

export function summarizeExecution(
  execution: LaunchExecutionResult,
  accounts: AccountConfig[],
): LaunchFeedback {
  const accountNames = new Map(accounts.map((account) => [account.id, account.displayName]));
  const label = (accountId: string) => accountNames.get(accountId) ?? accountId;
  const failed = execution.results.filter((item) => item.status === "failed");
  const verifying = execution.results.filter((item) => item.status === "unknown");
  const succeeded = execution.results.filter((item) => item.status === "succeeded");
  if (failed.length > 0 || verifying.length > 0) {
    return {
      tone: "danger",
      title: `创建失败 ${failed.length + verifying.length} 个广告组`,
      lines: [
        ...failed.map((item) => `${label(item.accountId)}：${item.message || "创建失败"}`),
        ...verifying.map((item) => `${label(item.accountId)}：结果核验失败：${item.message || "远端结果未确认"}；可只读重新核验，不会重复创建`),
      ],
    };
  }
  const skippedMaterials = countSkippedMaterials(succeeded);
  const succeededByAccount = new Map<string, number>();
  for (const item of succeeded) {
    succeededByAccount.set(item.accountId, (succeededByAccount.get(item.accountId) ?? 0) + 1);
  }
  return {
    tone: "success",
    title: skippedMaterials > 0
      ? `创建成功 ${succeeded.length} 个广告组（${skippedMaterials} 条素材失败，已跳过）`
      : `创建成功 ${succeeded.length} 个广告组`,
    lines: [...succeededByAccount].map(([accountId, count]) => `${label(accountId)}：成功 ${count} 个广告组`),
  };
}

type LaunchOutcome = {
  status: LaunchExecutionResult["results"][number]["status"];
  syncWarning: string | null;
};

export function countSkippedMaterials(outcomes: LaunchOutcome[]): number {
  return outcomes.reduce((total, item) => {
    if (item.status !== "succeeded" || !item.syncWarning?.includes("素材提示")) return total;
    const count = item.syncWarning.match(/已跳过\s*(\d+)\s*条素材/)?.[1];
    return total + (count ? Number(count) : 1);
  }, 0);
}

export function summarizeLaunchOutcomeToast(outcomes: LaunchOutcome[]): {
  message: string;
  tone: "success" | "error";
} {
  const succeeded = outcomes.filter((item) => item.status === "succeeded").length;
  const failed = outcomes.filter((item) => item.status === "failed" || item.status === "unknown").length;
  if (failed > 0) {
    return {
      message: succeeded > 0
        ? `创建完成：成功 ${succeeded} 个广告组，失败 ${failed} 个广告组`
        : `创建失败：${failed} 个广告组未创建`,
      tone: "error",
    };
  }
  const skippedMaterials = countSkippedMaterials(outcomes);
  if (skippedMaterials > 0) {
    return { message: `创建成功（${skippedMaterials} 条素材失败，已跳过）`, tone: "success" };
  }
  return {
    message: succeeded > 0 ? `创建任务全部成功（${succeeded} 个广告组）` : "创建任务全部成功",
    tone: "success",
  };
}

export function summarizePlanAccountResult(
  result: MultiAccountLaunchPlanRecord["executionResults"][number],
): { tone: "danger" | "warning"; text: string } | null {
  if (result.failedCount === 0 && result.unknownCount === 0) return null;
  if (result.failedCount === 0) {
    return {
      tone: "danger",
      text: `结果核验失败 ${result.unknownCount} 条${result.message ? `：${result.message}` : ""}`,
    };
  }
  return {
    tone: "danger",
    text: `失败 ${result.failedCount} 条${result.unknownCount > 0 ? ` · 结果核验失败 ${result.unknownCount} 条` : ""}${result.message ? `：${result.message}` : ""}`,
  };
}

function launchItemStatusLabel(status: LaunchPlanItemRecord["status"]): string {
  return ({ pending: "排队中", running: "执行中", succeeded: "已成功", failed: "失败", unknown: "失败（结果核验）", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function launchPhaseLabel(phase: LaunchPlanItemRecord["phase"]): string {
  return ({ validation: "校验", campaign_draft: "系列草稿", adgroup_draft: "广告组草稿", creative_draft: "广告草稿", publishing: "发布", readback: "回读", sync: "同步" } as Record<string, string>)[phase] ?? phase;
}
