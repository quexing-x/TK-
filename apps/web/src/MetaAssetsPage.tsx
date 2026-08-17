import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  CircleDollarSign,
  Layers3,
  ListChecks,
  Megaphone,
  Pause,
  Play,
  RefreshCcw,
  Search,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountConfig,
  AdOperationRecord,
  AutomationDecisionRecord,
  MetaAdCreationInput,
  MetaCallToAction,
  MetaCreationTaskRecord,
} from "@tk-auto/core";
import {
  api,
  type BootstrapPayload,
  type MetaAssetRecord,
} from "./api";
import { useAuth } from "./AuthGate";
import { CopyCampaignPanel } from "./CopyCampaignPanel";
import {
  configuredMetaStatus,
  filterMetaAssets,
  isMetaOperationPending,
  latestMetaOperationByEntity,
  metaAssetLevelLabel,
  metaStatusLabel,
  paginateMetaAssets,
  selectMetaExecutionReports,
  sortMetaAssetsForDisplay,
  type MetaAssetLevelFilter,
  type MetaAssetStatusFilter,
} from "./meta-assets-view";
import { hasProviderCapability } from "./provider-capability-view";
import {
  buildMetaCreationInput,
  defaultMetaCreationTargetLevel,
  metaCreationTargetCopy,
  metaCreationTaskTargetLevel,
} from "./meta-creation-view";
import { useOverlays } from "./ui/overlays";
import "./ui/pages/meta-assets.css";

const selectedMetaAccountStorageKey = "tk-auto:selected-meta-account-id";
const terminalOperationStatuses = new Set(["succeeded", "failed", "unknown", "cancelled"]);
const metaAssetPageSize = 20;
const metaExecutionReportLimit = 20;
const metaCreationUiEnabled = false;

interface MetaCreationDraft {
  targetLevel: MetaAdCreationInput["targetLevel"];
  campaignName: string;
  adSetName: string;
  creativeName: string;
  adName: string;
  dailyBudgetUsd: string;
  countries: string;
  destinationUrl: string;
  primaryText: string;
  headline: string;
  description: string;
  callToAction: MetaCallToAction;
  imageHash: string;
}

function newMetaCreationDraft(): MetaCreationDraft {
  const suffix = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return {
    targetLevel: defaultMetaCreationTargetLevel,
    campaignName: `TK Meta 广告系列 ${suffix}`,
    adSetName: `TK Meta 广告组 ${suffix}`,
    creativeName: `TK Meta 素材 ${suffix}`,
    adName: `TK Meta 广告 ${suffix}`,
    dailyBudgetUsd: "5",
    countries: "US",
    destinationUrl: "",
    primaryText: "Meta sandbox automation test",
    headline: "Meta sandbox test",
    description: "Created by TK Ads automation",
    callToAction: "LEARN_MORE",
    imageHash: "",
  };
}

export function MetaAssetsPage({
  accounts,
  connectionStates,
  onConnectionsChanged,
  onError,
  onOpenAccounts,
}: {
  accounts: AccountConfig[];
  connectionStates: BootstrapPayload["accountConnectionStates"];
  onConnectionsChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  onOpenAccounts: () => void;
}) {
  const auth = useAuth();
  const { confirm, toast } = useOverlays();
  const canOperateAds = auth.status.permissions.includes("ads:operate");
  const [selectedAccountId, setSelectedAccountId] = useState(() =>
    window.localStorage.getItem(selectedMetaAccountStorageKey) ?? "",
  );
  const [assets, setAssets] = useState<MetaAssetRecord[] | null>(null);
  const [operations, setOperations] = useState<AdOperationRecord[]>([]);
  const [decisions, setDecisions] = useState<AutomationDecisionRecord[]>([]);
  const [creationTasks, setCreationTasks] = useState<MetaCreationTaskRecord[]>([]);
  const [creationDraft, setCreationDraft] = useState<MetaCreationDraft>(newMetaCreationDraft);
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const creationTargetCopy = metaCreationTargetCopy(creationDraft.targetLevel);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<MetaAssetLevelFilter>("campaign");
  const [status, setStatus] = useState<MetaAssetStatusFilter>("all");
  const [assetPage, setAssetPage] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (accounts.some((account) => account.id === selectedAccountId)) return;
    const next = accounts[0]?.id ?? "";
    setSelectedAccountId(next);
    if (next) window.localStorage.setItem(selectedMetaAccountStorageKey, next);
  }, [accounts, selectedAccountId]);

  const selectAccount = (accountId: string) => {
    setSelectedAccountId(accountId);
    window.localStorage.setItem(selectedMetaAccountStorageKey, accountId);
  };
  const account = accounts.find((item) => item.id === selectedAccountId) ?? null;
  const connectionState = connectionStates.find((item) => item.accountId === selectedAccountId);
  const connection = connectionState?.connection ?? null;
  const capabilities = connectionState?.capabilities;
  const readReady = connection?.status === "ready"
    && hasProviderCapability(capabilities, "read-campaigns")
    && hasProviderCapability(capabilities, "read-ad-groups")
    && hasProviderCapability(capabilities, "read-ads");
  const statusReady = connection?.status === "ready"
    && hasProviderCapability(capabilities, "change-status");
  const creationReady = connection?.status === "ready"
    && connection.settings.kind === "meta-marketing-api"
    && connection.settings.creationMode === "paused-only"
    && hasProviderCapability(capabilities, "create-campaigns");
  const allowedStatusEntityTypes = connection?.settings.kind === "meta-marketing-api"
    ? connection.settings.allowedStatusEntityTypes ?? []
    : [];
  const statusReadyFor = (asset: MetaAssetRecord) =>
    statusReady && allowedStatusEntityTypes.includes(asset.entityType);

  const loadLocal = useCallback(async () => {
    if (!selectedAccountId) {
      setAssets([]);
      setOperations([]);
      setDecisions([]);
      setCreationTasks([]);
      setLoadError(null);
      return;
    }
    try {
      const [nextAssets, nextOperations, nextDecisions, nextCreationTasks] = await Promise.all([
        api.getMetaAssets(selectedAccountId),
        api.getAdOperations(selectedAccountId),
        api.getAutomationDecisions(selectedAccountId),
        metaCreationUiEnabled ? api.getMetaCreationTasks(selectedAccountId) : Promise.resolve([]),
      ]);
      setAssets(nextAssets.filter((item) => item.entityType !== ("material" as typeof item.entityType)));
      setOperations(nextOperations.filter((item) => item.providerKind === "meta-marketing-api"));
      setDecisions(nextDecisions);
      setCreationTasks(nextCreationTasks);
      setLoadError(null);
      onError(null);
    } catch (cause) {
      const message = getErrorMessage(cause);
      onError(message);
      setLoadError(message);
      setAssets([]);
      setOperations([]);
      setDecisions([]);
      setCreationTasks([]);
    }
  }, [onError, selectedAccountId]);

  useEffect(() => {
    setAssets(null);
    setOperations([]);
    setDecisions([]);
    setCreationTasks([]);
    void loadLocal();
  }, [loadLocal]);

  const refreshRemote = async () => {
    if (!account || !readReady) return;
    try {
      setBusy("sync");
      await api.syncReadOnly(account.id, "meta-marketing-api");
      await Promise.all([loadLocal(), onConnectionsChanged()]);
      toast("Meta 广告系列、广告组与广告已完成只读同步");
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const waitForOperation = async (taskId: string): Promise<AdOperationRecord | null> => {
    if (!account) return null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await delay(750);
      const nextOperations = await api.getAdOperations(account.id);
      setOperations(nextOperations.filter((item) => item.providerKind === "meta-marketing-api"));
      const task = nextOperations.find((item) => item.id === taskId) ?? null;
      if (task && terminalOperationStatuses.has(task.status)) return task;
    }
    return null;
  };

  const changeStatus = async (asset: MetaAssetRecord) => {
    if (!account || !statusReadyFor(asset) || !canOperateAds) return;
    const currentStatus = configuredMetaStatus(asset);
    if (currentStatus === "unknown") return;
    const action = currentStatus === "PAUSED" ? "enable" : "disable";
    const confirmed = await confirm({
      title: `${action === "enable" ? "启用" : "暂停"} ${metaAssetLevelLabel(asset.entityType)}`,
      message: `账户：${account.displayName}\n对象：${asset.name}（${asset.externalId}）\n目标：${action === "enable" ? "已开启" : "已暂停"}\n\n此操作只执行一次并强制写后回读；结果不明时不会自动重试。`,
      confirmLabel: action === "enable" ? "确认启用" : "确认暂停",
      danger: action === "disable",
    });
    if (!confirmed) return;
    const key = `${asset.entityType}:${asset.externalId}`;
    try {
      setBusy(`${key}:status`);
      const task = await api.changeMetaEntityStatus(account.id, {
        entityType: asset.entityType,
        externalId: asset.externalId,
        action,
      });
      setOperations((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      const terminal = await waitForOperation(task.id);
      await loadLocal();
      if (!terminal) {
        toast("任务仍在处理，请稍后查看操作记录");
      } else if (terminal.status === "succeeded") {
        toast(`Meta ${metaAssetLevelLabel(asset.entityType)} 已写后确认`);
      } else if (terminal.status === "unknown") {
        toast("远端结果待确认；系统不会自动重试，请执行只读核验");
      }
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async (operation: AdOperationRecord) => {
    if (!account || operation.status !== "unknown") return;
    try {
      setBusy(`${operation.id}:reconcile`);
      const result = await api.reconcileMetaStatusOperation(account.id, operation.operationId);
      setOperations((current) => [
        result.operation,
        ...current.filter((item) => item.id !== result.operation.id),
      ]);
      if (result.asset) {
        setAssets((current) => current?.map((item) =>
          item.entityType === result.asset?.entityType && item.externalId === result.asset.externalId
            ? result.asset
            : item,
        ) ?? []);
      }
      toast(result.message);
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const createMetaAd = async () => {
    if (!account || !creationReady || !canOperateAds) return;
    const budget = Number(creationDraft.dailyBudgetUsd);
    const countries = creationDraft.countries
      .split(/[,;\s]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
    if (!Number.isFinite(budget) || budget < 1) {
      onError("Meta 日预算至少为 1 USD。");
      return;
    }
    if (countries.length === 0 || countries.some((item) => !/^[A-Z]{2}$/.test(item))) {
      onError("国家使用两位代码，例如 US；多个国家用逗号分隔。");
      return;
    }
    let destinationUrl = "";
    if (creationDraft.targetLevel === "ad") {
      let parsedDestinationUrl: URL;
      try {
        parsedDestinationUrl = new URL(creationDraft.destinationUrl.trim());
      } catch {
        onError("请输入有效的 HTTPS 落地页 URL。");
        return;
      }
      if (parsedDestinationUrl.protocol !== "https:") {
        onError("落地页必须使用 HTTPS。");
        return;
      }
      destinationUrl = parsedDestinationUrl.toString();
    }
    const input = buildMetaCreationInput(creationDraft.targetLevel, {
      idempotencyKey: creationKey,
      campaignName: creationDraft.campaignName.trim(),
      adSetName: creationDraft.adSetName.trim(),
      objective: "OUTCOME_TRAFFIC",
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      destinationType: "WEBSITE",
      dailyBudgetMinorUnits: Math.round(budget * 100),
      countries,
    }, {
      creativeName: creationDraft.creativeName.trim(),
      adName: creationDraft.adName.trim(),
      destinationUrl,
      primaryText: creationDraft.primaryText.trim(),
      headline: creationDraft.headline.trim(),
      description: creationDraft.description.trim(),
      callToAction: creationDraft.callToAction,
      imageHash: creationDraft.imageHash.trim() || null,
    });
    try {
      setBusy("meta-create");
      const task = await api.createMetaAd(account.id, input);
      setCreationTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      if (task.status === "succeeded") {
        setCreationKey(crypto.randomUUID());
        setCreationDraft(newMetaCreationDraft());
        await loadLocal();
        toast(creationTargetCopy.success);
      } else if (task.status === "unknown") {
        toast("创建结果存在待确认阶段；系统不会自动重放");
      } else {
        onError(task.message ?? "Meta 创建失败。");
      }
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const retryMetaCreation = async (task: MetaCreationTaskRecord) => {
    if (!account || task.status !== "failed" || !creationReady) return;
    try {
      setBusy(`meta-create:${task.id}`);
      const updated = await api.retryMetaAdCreation(account.id, task.id);
      setCreationTasks((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      if (updated.status === "succeeded") {
        await loadLocal();
        toast(`Meta ${metaCreationTargetCopy(metaCreationTaskTargetLevel(updated)).label}创建任务已从上次确认层级继续并完成`);
      } else if (updated.status === "unknown") {
        toast("重试阶段结果待确认，系统不会再次自动重放");
      }
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const reconcileMetaCreation = async (task: MetaCreationTaskRecord) => {
    if (!account || task.status !== "unknown" || !creationReady) return;
    try {
      setBusy(`meta-create:${task.id}`);
      const updated = await api.reconcileMetaAdCreation(account.id, task.id);
      setCreationTasks((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      if (updated.status === "succeeded") {
        await loadLocal();
        toast(`Meta ${metaCreationTargetCopy(metaCreationTaskTargetLevel(updated)).label}创建结果已通过只读对账确认`);
      } else if (updated.status === "failed") {
        toast("只读对账已确认可从现有层级安全继续");
      } else {
        toast("只读对账仍无法唯一确认；任务保持 unknown");
      }
    } catch (cause) {
      onError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const filteredAssets = useMemo(
    () => sortMetaAssetsForDisplay(filterMetaAssets(assets ?? [], { level, status, query })),
    [assets, level, query, status],
  );
  const assetPageResult = useMemo(
    () => paginateMetaAssets(filteredAssets, assetPage, metaAssetPageSize),
    [assetPage, filteredAssets],
  );
  const executionReports = useMemo(
    () => selectMetaExecutionReports(decisions).slice(0, metaExecutionReportLimit),
    [decisions],
  );

  useEffect(() => {
    setAssetPage(0);
  }, [level, query, selectedAccountId, status]);

  useEffect(() => {
    if (assetPage !== assetPageResult.page) setAssetPage(assetPageResult.page);
  }, [assetPage, assetPageResult.page]);
  const latestOperations = useMemo(
    () => latestMetaOperationByEntity(operations),
    [operations],
  );
  const campaignSummaryAssets = (assets ?? []).filter((asset) => asset.entityType === "campaign");
  const adGroupSummaryAssets = (assets ?? []).filter((asset) => asset.entityType === "ad-group");
  const summaryAssets = campaignSummaryAssets.length > 0
    ? campaignSummaryAssets
    : adGroupSummaryAssets.length > 0
      ? adGroupSummaryAssets
      : (assets ?? []);
  const spendTotal = summaryAssets.reduce((total, asset) => total + (asset.metrics.spend ?? 0), 0);
  const cartsTotal = summaryAssets.reduce((total, asset) => total + (asset.metrics.carts ?? 0), 0);
  const conversionsTotal = summaryAssets.reduce((total, asset) => total + (asset.metrics.conversions ?? 0), 0);
  const cpa = conversionsTotal > 0 ? spendTotal / conversionsTotal : null;

  if (accounts.length === 0) {
    return (
      <section className="page-stack meta-assets-page">
        <div className="panel meta-empty-state">
          <Layers3 size={28} />
          <h2>尚未建立 Meta 账户</h2>
          <p>先在总览新增 Meta Ads 账户并完成 Marketing API 接入。</p>
          <button className="primary-button" onClick={onOpenAccounts} type="button">前往账户接入</button>
        </div>
      </section>
    );
  }

  return (
    <section className="page-stack meta-assets-page">
      <header className="meta-workspace-header">
        <div>
          <span className="eyebrow">META 广告管理</span>
          <h2>广告系列优先的独立工作区</h2>
          <p>Meta 与 TikTok 完全分开；默认先看广告系列，需要时再切换到广告组或广告。本页不会启动背景调度。</p>
        </div>
        <label className="field meta-account-picker">
          <span>Meta 账户</span>
          <select value={selectedAccountId} onChange={(event) => selectAccount(event.target.value)}>
            {accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
      </header>

      <div className="meta-status-strip">
        <span><ShieldCheck size={16} /><strong>连接</strong>{metaConnectionStatusLabel(connection?.status)}</span>
        <span><Activity size={16} /><strong>读取</strong>{readReady ? "可用" : "未就绪"}</span>
        <span><CheckCircle2 size={16} /><strong>手动启停</strong>{statusReady ? "可用" : "未就绪"}</span>
        <span className="meta-scheduler-off"><Pause size={16} /><strong>背景调度</strong>由 Meta 规则页独立控制</span>
        <button className="secondary-button" disabled={!readReady || busy !== null} onClick={() => void refreshRemote()} type="button">
          <RefreshCcw className={busy === "sync" ? "spin" : ""} size={16} />
          {busy === "sync" ? "同步中…" : "只读同步"}
        </button>
      </div>

      <div className="meta-asset-summary" aria-label="Meta 资产摘要">
        <article><span className="meta-summary-icon"><Layers3 size={16} /></span><small>广告对象</small><strong>{assets?.length ?? 0}</strong><span>广告系列 / 广告组 / 广告</span></article>
        <article><span className="meta-summary-icon"><CircleDollarSign size={16} /></span><small>当前快照消耗</small><strong>{formatMetaNumber(spendTotal)}</strong><span>按广告系列汇总 · 账户币种</span></article>
        <article><span className="meta-summary-icon"><ShoppingCart size={16} /></span><small>加购</small><strong>{formatMetaNumber(cartsTotal)}</strong><span>按广告系列汇总</span></article>
        <article><span className="meta-summary-icon"><TrendingUp size={16} /></span><small>转化</small><strong>{formatMetaNumber(conversionsTotal)}</strong><span>{cpa === null ? "暂无 CPA" : `平均 CPA ${formatMetaNumber(cpa)}`}</span></article>
      </div>

      <div className="meta-create-module">
        <div className="panel-heading meta-create-module-heading">
          <div><span className="panel-icon"><Megaphone size={18} /></span><div><h2>Meta 创建与一键扩组</h2><p>优先按广告系列复制 Campaign + Ad Set；创建区已加“禁止新帖子”门禁，不读取或创建 Creative / Ad。</p></div></div>
          <span className="status active">无 Page ID 可执行两层复制</span>
        </div>
        <CopyCampaignPanel
          accounts={accounts.map((item) => ({ id: item.id, displayName: item.displayName, timezone: item.timezone }))}
          busy={busy !== null}
          onCompleted={() => loadLocal()}
          onError={onError}
          platform="meta"
        />
      </div>

      {metaCreationUiEnabled && <div className="panel meta-create-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><Megaphone size={18} /></span><div><h2>创建 Meta 广告对象</h2><p>{creationTargetCopy.description}</p></div></div>
          <span className={creationReady ? "status active" : "status warning"}>{creationReady ? "创建已就绪 · USD" : "需在接入页开启“仅创建已暂停广告”并重新检测"}</span>
        </div>
        <div className="form-grid meta-create-form">
          <fieldset className="meta-create-target meta-create-wide">
            <legend>创建层级</legend>
            <div className="meta-create-target-options">
              <label className={creationDraft.targetLevel === "ad-set" ? "selected" : undefined}>
                <input checked={creationDraft.targetLevel === "ad-set"} name="meta-creation-target" onChange={() => setCreationDraft({ ...creationDraft, targetLevel: "ad-set" })} type="radio" value="ad-set" />
                <span><strong>广告系列 + 广告组</strong><small>默认 · 只创建两层</small></span>
              </label>
              <label className={creationDraft.targetLevel === "ad" ? "selected" : undefined}>
                <input checked={creationDraft.targetLevel === "ad"} name="meta-creation-target" onChange={() => setCreationDraft({ ...creationDraft, targetLevel: "ad" })} type="radio" value="ad" />
                <span><strong>完整四层</strong><small>包含素材与广告</small></span>
              </label>
            </div>
            <p>{creationTargetCopy.description}</p>
          </fieldset>
          <label className="field"><span>广告系列名称</span><input maxLength={400} value={creationDraft.campaignName} onChange={(event) => setCreationDraft({ ...creationDraft, campaignName: event.target.value })} /></label>
          <label className="field"><span>广告组名称</span><input maxLength={400} value={creationDraft.adSetName} onChange={(event) => setCreationDraft({ ...creationDraft, adSetName: event.target.value })} /></label>
          <label className="field"><span>日预算（USD）</span><input min="1" step="0.01" type="number" value={creationDraft.dailyBudgetUsd} onChange={(event) => setCreationDraft({ ...creationDraft, dailyBudgetUsd: event.target.value })} /></label>
          <label className="field"><span>投放国家</span><input placeholder="US" value={creationDraft.countries} onChange={(event) => setCreationDraft({ ...creationDraft, countries: event.target.value })} /></label>
          {creationDraft.targetLevel === "ad" && <>
            <label className="field"><span>素材名称</span><input maxLength={400} value={creationDraft.creativeName} onChange={(event) => setCreationDraft({ ...creationDraft, creativeName: event.target.value })} /></label>
            <label className="field"><span>广告名称</span><input maxLength={400} value={creationDraft.adName} onChange={(event) => setCreationDraft({ ...creationDraft, adName: event.target.value })} /></label>
            <label className="field meta-create-wide"><span>HTTPS 落地页</span><input placeholder="https://example.com/product" type="url" value={creationDraft.destinationUrl} onChange={(event) => setCreationDraft({ ...creationDraft, destinationUrl: event.target.value })} /></label>
            <label className="field meta-create-wide"><span>主要文本</span><textarea maxLength={500} rows={3} value={creationDraft.primaryText} onChange={(event) => setCreationDraft({ ...creationDraft, primaryText: event.target.value })} /></label>
            <label className="field"><span>标题</span><input maxLength={255} value={creationDraft.headline} onChange={(event) => setCreationDraft({ ...creationDraft, headline: event.target.value })} /></label>
            <label className="field"><span>描述</span><input maxLength={255} value={creationDraft.description} onChange={(event) => setCreationDraft({ ...creationDraft, description: event.target.value })} /></label>
            <label className="field"><span>行动按钮</span><select value={creationDraft.callToAction} onChange={(event) => setCreationDraft({ ...creationDraft, callToAction: event.target.value as MetaCallToAction })}><option value="LEARN_MORE">了解更多</option><option value="SHOP_NOW">立即购买</option><option value="SIGN_UP">注册</option><option value="CONTACT_US">联系我们</option><option value="NO_BUTTON">无按钮</option></select></label>
            <label className="field"><span>图片 Hash（可选）</span><input placeholder="留空时由 Meta 读取落地页预览" value={creationDraft.imageHash} onChange={(event) => setCreationDraft({ ...creationDraft, imageHash: event.target.value })} /></label>
          </>}
        </div>
        <div className="connection-inline-actions">
          <button className="primary-button" disabled={!creationReady || !canOperateAds || busy !== null} onClick={() => void createMetaAd()} type="button"><Megaphone size={16} />{busy === "meta-create" ? "逐层创建中…" : creationTargetCopy.button}</button>
          <small>请求键：{creationKey.slice(0, 8)} · 失败重试会从已确认 ID 继续</small>
        </div>
        {creationTasks.length > 0 && <div className="table-wrap meta-create-history"><table><thead><tr><th>时间 / 任务</th><th>目标 / 阶段</th><th>状态</th><th>远端 ID</th><th>结果</th><th>操作</th></tr></thead><tbody>{creationTasks.slice(0, 10).map((task) => {
          const taskTargetLevel = metaCreationTaskTargetLevel(task);
          return <tr key={task.id}><td>{new Date(task.createdAt).toLocaleString()}<br /><small>{task.id.slice(0, 8)}</small></td><td><strong>{metaCreationTargetCopy(taskTargetLevel).label}</strong><br /><small>{creationPhaseLabel(task.phase)}</small></td><td><span className={creationTaskStatusClass(task.status)}>{creationTaskStatusLabel(task.status)}</span></td><td><small>系列 {task.campaignId ?? "—"}<br />组 {task.adSetId ?? "—"}{taskTargetLevel === "ad" && <><br />素材 {task.creativeId ?? "—"}<br />广告 {task.adId ?? "—"}</>}</small></td><td><small>{task.message ?? "—"}</small></td><td>{task.status === "failed" ? <button disabled={!creationReady || busy !== null} onClick={() => void retryMetaCreation(task)} type="button"><RefreshCcw size={14} />{busy === `meta-create:${task.id}` ? "重试中…" : "继续"}</button> : task.status === "unknown" ? <button disabled={!creationReady || busy !== null} onClick={() => void reconcileMetaCreation(task)} type="button"><RefreshCcw size={14} />{busy === `meta-create:${task.id}` ? "对账中…" : "只读对账"}</button> : "—"}</td></tr>;
        })}</tbody></table></div>}
      </div>}

      <div className="panel meta-filter-panel">
        <label className="field"><span>名称或 ID</span><div className="meta-search-input"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Meta 对象" /></div></label>
        <label className="field"><span>层级</span><select value={level} onChange={(event) => setLevel(event.target.value as MetaAssetLevelFilter)}><option value="campaign">广告系列（默认）</option><option value="all">全部层级</option><option value="ad-group">广告组</option><option value="ad">广告</option></select></label>
        <label className="field"><span>配置状态</span><select value={status} onChange={(event) => setStatus(event.target.value as MetaAssetStatusFilter)}><option value="all">全部状态</option><option value="ACTIVE">已开启</option><option value="PAUSED">已暂停</option><option value="unknown">待核验</option></select></label>
      </div>

      <div className="panel table-panel meta-assets-table-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><BarChart3 size={18} /></span><div><h2>Meta 广告系列与广告对象 <em className="heading-count">{filteredAssets.length}</em></h2><p>默认显示广告系列；状态与投放指标分列展示，便于直接对照 TK 管理界面。</p></div></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>对象</th><th>层级</th><th>父级</th><th>配置状态</th><th>投放状态</th><th>消耗</th><th>加购</th><th>转化</th><th>CPA</th><th>CPC</th><th>最近同步</th><th>最近操作</th><th>操作</th></tr></thead>
            <tbody>
              {assets === null ? <tr><td colSpan={13}>正在读取本地 Meta 快照…</td></tr> : loadError ? <tr><td colSpan={13}>本地 Meta 快照读取失败：{loadError}</td></tr> : filteredAssets.length === 0 ? <tr><td colSpan={13}>{assets.length === 0 ? "暂无本地快照。请先完成连接检测，再明确点击“只读同步”。" : "当前筛选条件下没有对象。"}</td></tr> : assetPageResult.items.map((asset) => {
                const key = `${asset.entityType}:${asset.externalId}`;
                const operation = latestOperations.get(key);
                const configuredStatus = configuredMetaStatus(asset);
                const pending = isMetaOperationPending(operation);
                const actionBusy = busy === `${key}:status`;
                const levelStatusReady = statusReadyFor(asset);
                return (
                  <tr key={key}>
                    <td><strong>{asset.name}</strong><br /><small>{asset.externalId}</small></td>
                    <td>{metaAssetLevelLabel(asset.entityType)}</td>
                    <td><small>{asset.parentAdGroupId ? `广告组 ${asset.parentAdGroupId}` : asset.parentCampaignId ? `广告系列 ${asset.parentCampaignId}` : "—"}</small></td>
                    <td><span className={configuredStatus === "ACTIVE" ? "status active" : configuredStatus === "PAUSED" ? "status" : "status warning"} title={configuredStatus}>{metaStatusLabel(configuredStatus)}</span></td>
                    <td><span className={asset.effectiveStatus?.includes("ACTIVE") ? "status active" : "status warning"} title={asset.effectiveStatus ?? undefined}>{metaStatusLabel(asset.effectiveStatus ?? "unknown")}</span></td>
                    <td className="meta-metric-cell">{formatMetaNumber(asset.metrics.spend)}</td>
                    <td className="meta-metric-cell">{formatMetaNumber(asset.metrics.carts)}</td>
                    <td className="meta-metric-cell">{formatMetaNumber(asset.metrics.conversions)}</td>
                    <td className="meta-metric-cell">{formatMetaNumber(asset.metrics.cost_per_conversion)}</td>
                    <td className="meta-metric-cell">{formatMetaNumber(asset.metrics.cost_per_click)}</td>
                    <td>{new Date(asset.syncedAt).toLocaleString()}</td>
                    <td>{operation ? <><span className={operationStatusClass(operation.status)}>{operationStatusLabel(operation.status)}</span><br /><small>{operation.message ?? "—"}</small></> : "—"}</td>
                    <td><div className="row-actions">
                      {operation?.status === "unknown" ? (
                        <button disabled={busy !== null || !canOperateAds} onClick={() => void reconcile(operation)} type="button"><RefreshCcw size={14} /> {busy === `${operation.id}:reconcile` ? "核验中…" : "只读核验"}</button>
                      ) : (
                        <button disabled={!levelStatusReady || !canOperateAds || pending || busy !== null || configuredStatus === "unknown"} onClick={() => void changeStatus(asset)} title={!canOperateAds ? "需要 ads:operate 权限" : !levelStatusReady ? "该层级未获 Meta 手动启停授权" : undefined} type="button">
                          {configuredStatus === "PAUSED" ? <Play size={14} /> : <Pause size={14} />}
                          {actionBusy || pending ? "处理中…" : configuredStatus === "PAUSED" ? "设为已开启" : "设为已暂停"}
                        </button>
                      )}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="table-pagination meta-assets-pagination" aria-label="Meta 广告对象分页">
          <span>每页 {metaAssetPageSize} 条 · 第 {assetPageResult.page + 1} / {assetPageResult.pageCount} 页 · 共 {assetPageResult.total} 条</span>
          <div className="row-actions">
            <button disabled={assetPageResult.page === 0} onClick={() => setAssetPage((page) => Math.max(0, page - 1))} type="button">上一页</button>
            <button disabled={assetPageResult.page >= assetPageResult.pageCount - 1} onClick={() => setAssetPage((page) => Math.min(assetPageResult.pageCount - 1, page + 1))} type="button">下一页</button>
          </div>
        </div>
      </div>

      {!statusReady && <div className="alert warning-alert"><CircleAlert size={18} /><span>手动启停尚未开放。请先完成 Meta 接入检测，并确认对应层级的手动启停授权。</span></div>}

      <div className="panel table-panel meta-execution-report-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><ListChecks size={18} /></span><div><h2>Meta 自动化执行报告 <em className="heading-count">{executionReports.length}</em></h2><p>仅展示 Meta 独立规则引擎的最近 {metaExecutionReportLimit} 条判定与执行结果，不混入 TikTok 记录。</p></div></div>
          <button className="secondary-button" disabled={busy !== null} onClick={() => void loadLocal()} type="button"><RefreshCcw size={16} /> 刷新报告</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>对象</th><th>层级</th><th>命中条件</th><th>动作</th><th>结果</th><th>时间</th></tr></thead>
            <tbody>
              {executionReports.length === 0 ? <tr><td colSpan={6}>暂无 Meta 自动化执行记录。开启 Meta 规则并完成一轮检测后会显示在这里。</td></tr> : executionReports.map((decision) => (
                <tr key={decision.id}>
                  <td><strong>{decision.entityName}</strong><br /><small>{decision.externalId}</small></td>
                  <td>{metaDecisionEntityLabel(decision.entityType)}</td>
                  <td className="meta-report-condition">{metaDecisionMetricLabel(decision.metric)} {metaDecisionOperatorLabel(decision.operator)} {decision.thresholdValue}<br /><small>当前 {decision.metricValue} · {decision.thresholdCode}</small><br /><small>{decision.reason}</small><br /><small>指标快照：{formatMetaMetricSnapshot(decision.metricSnapshot)}</small></td>
                  <td>{decision.action === "enable" ? "开启" : "暂停"}</td>
                  <td><span className={metaDecisionStatusClass(decision.status)}>{metaDecisionStatusLabel(decision.status)}</span>{decision.errorMessage && <small className="meta-report-error">{decision.errorMessage}</small>}<small className={decision.dataQualityStatus === "healthy" ? undefined : "meta-report-error"}>数据质量：{metaDataQualityLabel(decision.dataQualityStatus)}。{decision.dataQualityWarnings.length > 0 ? decision.dataQualityWarnings.join("；") : "无警告"}</small></td>
                  <td className="meta-report-time">{new Date(decision.createdAt).toLocaleString("zh-CN", { hour12: false })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function operationStatusLabel(status: AdOperationRecord["status"]): string {
  return {
    pending: "等待",
    running: "执行中",
    succeeded: "成功",
    failed: "失败",
    unknown: "待核验",
    cancelled: "已取消",
  }[status];
}

function operationStatusClass(status: AdOperationRecord["status"]): string {
  if (status === "succeeded") return "status active";
  if (status === "failed" || status === "cancelled") return "status danger";
  return "status warning";
}

function creationTaskStatusClass(status: MetaCreationTaskRecord["status"]): string {
  if (status === "succeeded") return "status active";
  if (status === "failed") return "status danger";
  return "status warning";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Meta 页面发生未知错误。";
}

function metaConnectionStatusLabel(status: string | undefined): string {
  return {
    ready: "正常",
    failed: "失败",
    pending: "检测中",
    disabled: "未启用",
  }[status ?? ""] ?? "未配置";
}

function creationTaskStatusLabel(status: MetaCreationTaskRecord["status"]): string {
  return {
    pending: "等待",
    running: "执行中",
    succeeded: "成功",
    failed: "失败",
    unknown: "待核验",
    cancelled: "已取消",
  }[status];
}

function creationPhaseLabel(phase: MetaCreationTaskRecord["phase"]): string {
  return {
    pending: "等待开始",
    campaign: "广告系列",
    "ad-set": "广告组",
    creative: "素材",
    ad: "广告",
    completed: "已完成",
  }[phase] ?? phase;
}

function metaDecisionEntityLabel(entityType: AutomationDecisionRecord["entityType"]): string {
  return {
    campaign: "广告系列",
    "ad-group": "广告组",
    ad: "广告",
    material: "素材",
  }[entityType];
}

function metaDecisionMetricLabel(metric: AutomationDecisionRecord["metric"]): string {
  return {
    cost_per_conversion: "平均转化成本",
    cost_per_click: "平均点击成本",
    cost_per_cart: "平均加购成本",
    budget: "预算",
    spend: "消耗",
    conversions: "转化量",
    clicks: "点击量",
    custom: "自定义指标",
  }[metric];
}

function metaDecisionOperatorLabel(operator: AutomationDecisionRecord["operator"]): string {
  return { gt: ">", gte: "≥", lt: "<", lte: "≤" }[operator];
}

function metaDecisionStatusLabel(status: AutomationDecisionRecord["status"]): string {
  return {
    preview: "预览命中",
    pending: "等待执行",
    succeeded: "执行成功",
    failed: "执行失败",
    unknown: "结果待确认",
    skipped: "安全跳过",
  }[status];
}

function metaDecisionStatusClass(status: AutomationDecisionRecord["status"]): string {
  if (status === "succeeded") return "status active";
  if (status === "failed" || status === "unknown") return "status danger";
  return "status warning";
}

function metaDataQualityLabel(status: AutomationDecisionRecord["dataQualityStatus"]): string {
  return {
    healthy: "健康",
    partial: "部分可用",
    stale: "已过期",
    invalid: "无效",
  }[status];
}

function formatMetaMetricSnapshot(
  snapshot: AutomationDecisionRecord["metricSnapshot"],
): string {
  return [
    ["消耗", snapshot.spend],
    ["预算", snapshot.budget],
    ["点击", snapshot.clicks],
    ["转化", snapshot.conversions],
    ["加购", snapshot.carts],
    ["展示", snapshot.impressions],
    ["CPC", snapshot.cost_per_click],
    ["CPA", snapshot.cost_per_conversion],
    ["加购成本", snapshot.cost_per_cart],
  ].map(([label, value]) => `${label} ${formatMetaNumber(value as number | null)}`).join(" · ");
}

function formatMetaNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}
