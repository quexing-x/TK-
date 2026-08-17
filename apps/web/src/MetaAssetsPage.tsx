import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Layers3,
  Megaphone,
  Pause,
  Play,
  RefreshCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountConfig,
  AdOperationRecord,
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
import {
  configuredMetaStatus,
  filterMetaAssets,
  isMetaOperationPending,
  latestMetaOperationByEntity,
  metaAssetLevelLabel,
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
    campaignName: `TK AUTO Meta Traffic ${suffix}`,
    adSetName: `TK AUTO Meta Ad Set ${suffix}`,
    creativeName: `TK AUTO Meta Creative ${suffix}`,
    adName: `TK AUTO Meta Ad ${suffix}`,
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
  const [creationTasks, setCreationTasks] = useState<MetaCreationTaskRecord[]>([]);
  const [creationDraft, setCreationDraft] = useState<MetaCreationDraft>(newMetaCreationDraft);
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const creationTargetCopy = metaCreationTargetCopy(creationDraft.targetLevel);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<MetaAssetLevelFilter>("all");
  const [status, setStatus] = useState<MetaAssetStatusFilter>("all");
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
      setCreationTasks([]);
      setLoadError(null);
      return;
    }
    try {
      const [nextAssets, nextOperations, nextCreationTasks] = await Promise.all([
        api.getMetaAssets(selectedAccountId),
        api.getAdOperations(selectedAccountId),
        api.getMetaCreationTasks(selectedAccountId),
      ]);
      setAssets(nextAssets.filter((item) => item.entityType !== ("material" as typeof item.entityType)));
      setOperations(nextOperations.filter((item) => item.providerKind === "meta-marketing-api"));
      setCreationTasks(nextCreationTasks);
      setLoadError(null);
      onError(null);
    } catch (cause) {
      const message = getErrorMessage(cause);
      onError(message);
      setLoadError(message);
      setAssets([]);
    }
  }, [onError, selectedAccountId]);

  useEffect(() => {
    setAssets(null);
    void loadLocal();
  }, [loadLocal]);

  const refreshRemote = async () => {
    if (!account || !readReady) return;
    try {
      setBusy("sync");
      await api.syncReadOnly(account.id, "meta-marketing-api");
      await Promise.all([loadLocal(), onConnectionsChanged()]);
      toast("Meta Campaign、Ad Set 与 Ad 已完成只读同步");
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
      message: `账户：${account.displayName}\n对象：${asset.name}（${asset.externalId}）\n目标：${action === "enable" ? "ACTIVE" : "PAUSED"}\n\n此操作只执行一次并强制写后回读；结果不明时不会自动重试。`,
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
    () => filterMetaAssets(assets ?? [], { level, status, query }),
    [assets, level, query, status],
  );
  const latestOperations = useMemo(
    () => latestMetaOperationByEntity(operations),
    [operations],
  );
  const activeCount = (assets ?? []).filter((asset) => configuredMetaStatus(asset) === "ACTIVE").length;
  const pausedCount = (assets ?? []).filter((asset) => configuredMetaStatus(asset) === "PAUSED").length;
  const unknownCount = (assets ?? []).filter((asset) => configuredMetaStatus(asset) === "unknown").length;

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
          <span className="eyebrow">META MANUAL CONTROL</span>
          <h2>Campaign / Ad Set / Ad</h2>
          <p>只读同步必须明确点击；手动启停单次执行、写后回读。本页不会启动背景调度。</p>
        </div>
        <label className="field meta-account-picker">
          <span>Meta 账户</span>
          <select value={selectedAccountId} onChange={(event) => selectAccount(event.target.value)}>
            {accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
      </header>

      <div className="meta-status-strip">
        <span><ShieldCheck size={16} /><strong>连接</strong>{connection?.status ?? "not-configured"}</span>
        <span><Activity size={16} /><strong>读取</strong>{readReady ? "可用" : "未就绪"}</span>
        <span><CheckCircle2 size={16} /><strong>手动启停</strong>{statusReady ? "可用" : "未就绪"}</span>
        <span className="meta-scheduler-off"><Pause size={16} /><strong>背景调度</strong>由 Meta 规则页独立控制</span>
        <button className="secondary-button" disabled={!readReady || busy !== null} onClick={() => void refreshRemote()} type="button">
          <RefreshCcw className={busy === "sync" ? "spin" : ""} size={16} />
          {busy === "sync" ? "同步中…" : "只读同步"}
        </button>
      </div>

      <div className="meta-asset-summary" aria-label="Meta 资产摘要">
        <article><small>对象总数</small><strong>{assets?.length ?? 0}</strong><span>三层本地快照</span></article>
        <article><small>ACTIVE</small><strong>{activeCount}</strong><span>配置状态</span></article>
        <article><small>PAUSED</small><strong>{pausedCount}</strong><span>配置状态</span></article>
        <article><small>待核验</small><strong>{unknownCount}</strong><span>禁止自动重试</span></article>
      </div>

      <div className="panel meta-create-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><Megaphone size={18} /></span><div><h2>创建 Meta 广告对象</h2><p>{creationTargetCopy.description}</p></div></div>
          <span className={creationReady ? "status active" : "status warning"}>{creationReady ? "创建已就绪 · USD" : "需在接入页开启 PAUSED only 并重新检测"}</span>
        </div>
        <div className="form-grid meta-create-form">
          <fieldset className="meta-create-target meta-create-wide">
            <legend>创建层级</legend>
            <div className="meta-create-target-options">
              <label className={creationDraft.targetLevel === "ad-set" ? "selected" : undefined}>
                <input checked={creationDraft.targetLevel === "ad-set"} name="meta-creation-target" onChange={() => setCreationDraft({ ...creationDraft, targetLevel: "ad-set" })} type="radio" value="ad-set" />
                <span><strong>Campaign + Ad Set</strong><small>默认 · 只创建两层</small></span>
              </label>
              <label className={creationDraft.targetLevel === "ad" ? "selected" : undefined}>
                <input checked={creationDraft.targetLevel === "ad"} name="meta-creation-target" onChange={() => setCreationDraft({ ...creationDraft, targetLevel: "ad" })} type="radio" value="ad" />
                <span><strong>完整四层</strong><small>包含 Creative 与 Ad</small></span>
              </label>
            </div>
            <p>{creationTargetCopy.description}</p>
          </fieldset>
          <label className="field"><span>Campaign 名称</span><input maxLength={400} value={creationDraft.campaignName} onChange={(event) => setCreationDraft({ ...creationDraft, campaignName: event.target.value })} /></label>
          <label className="field"><span>Ad Set 名称</span><input maxLength={400} value={creationDraft.adSetName} onChange={(event) => setCreationDraft({ ...creationDraft, adSetName: event.target.value })} /></label>
          <label className="field"><span>日预算（USD）</span><input min="1" step="0.01" type="number" value={creationDraft.dailyBudgetUsd} onChange={(event) => setCreationDraft({ ...creationDraft, dailyBudgetUsd: event.target.value })} /></label>
          <label className="field"><span>投放国家</span><input placeholder="US" value={creationDraft.countries} onChange={(event) => setCreationDraft({ ...creationDraft, countries: event.target.value })} /></label>
          {creationDraft.targetLevel === "ad" && <>
            <label className="field"><span>Creative 名称</span><input maxLength={400} value={creationDraft.creativeName} onChange={(event) => setCreationDraft({ ...creationDraft, creativeName: event.target.value })} /></label>
            <label className="field"><span>Ad 名称</span><input maxLength={400} value={creationDraft.adName} onChange={(event) => setCreationDraft({ ...creationDraft, adName: event.target.value })} /></label>
            <label className="field meta-create-wide"><span>HTTPS 落地页</span><input placeholder="https://example.com/product" type="url" value={creationDraft.destinationUrl} onChange={(event) => setCreationDraft({ ...creationDraft, destinationUrl: event.target.value })} /></label>
            <label className="field meta-create-wide"><span>主要文本</span><textarea maxLength={500} rows={3} value={creationDraft.primaryText} onChange={(event) => setCreationDraft({ ...creationDraft, primaryText: event.target.value })} /></label>
            <label className="field"><span>标题</span><input maxLength={255} value={creationDraft.headline} onChange={(event) => setCreationDraft({ ...creationDraft, headline: event.target.value })} /></label>
            <label className="field"><span>描述</span><input maxLength={255} value={creationDraft.description} onChange={(event) => setCreationDraft({ ...creationDraft, description: event.target.value })} /></label>
            <label className="field"><span>行动按钮</span><select value={creationDraft.callToAction} onChange={(event) => setCreationDraft({ ...creationDraft, callToAction: event.target.value as MetaCallToAction })}><option value="LEARN_MORE">LEARN_MORE</option><option value="SHOP_NOW">SHOP_NOW</option><option value="SIGN_UP">SIGN_UP</option><option value="CONTACT_US">CONTACT_US</option><option value="NO_BUTTON">NO_BUTTON</option></select></label>
            <label className="field"><span>图片 Hash（可选）</span><input placeholder="留空时由 Meta 读取落地页预览" value={creationDraft.imageHash} onChange={(event) => setCreationDraft({ ...creationDraft, imageHash: event.target.value })} /></label>
          </>}
        </div>
        <div className="connection-inline-actions">
          <button className="primary-button" disabled={!creationReady || !canOperateAds || busy !== null} onClick={() => void createMetaAd()} type="button"><Megaphone size={16} />{busy === "meta-create" ? "逐层创建中…" : creationTargetCopy.button}</button>
          <small>请求键：{creationKey.slice(0, 8)} · 失败重试会从已确认 ID 继续</small>
        </div>
        {creationTasks.length > 0 && <div className="table-wrap meta-create-history"><table><thead><tr><th>时间 / 任务</th><th>目标 / 阶段</th><th>状态</th><th>远端 ID</th><th>结果</th><th>操作</th></tr></thead><tbody>{creationTasks.slice(0, 10).map((task) => {
          const taskTargetLevel = metaCreationTaskTargetLevel(task);
          return <tr key={task.id}><td>{new Date(task.createdAt).toLocaleString()}<br /><small>{task.id.slice(0, 8)}</small></td><td><strong>{metaCreationTargetCopy(taskTargetLevel).label}</strong><br /><small>{task.phase}</small></td><td><span className={creationTaskStatusClass(task.status)}>{task.status}</span></td><td><small>C {task.campaignId ?? "—"}<br />S {task.adSetId ?? "—"}{taskTargetLevel === "ad" && <><br />Cr {task.creativeId ?? "—"}<br />A {task.adId ?? "—"}</>}</small></td><td><small>{task.message ?? "—"}</small></td><td>{task.status === "failed" ? <button disabled={!creationReady || busy !== null} onClick={() => void retryMetaCreation(task)} type="button"><RefreshCcw size={14} />{busy === `meta-create:${task.id}` ? "重试中…" : "继续"}</button> : task.status === "unknown" ? <button disabled={!creationReady || busy !== null} onClick={() => void reconcileMetaCreation(task)} type="button"><RefreshCcw size={14} />{busy === `meta-create:${task.id}` ? "对账中…" : "只读对账"}</button> : "—"}</td></tr>;
        })}</tbody></table></div>}
      </div>

      <div className="panel meta-filter-panel">
        <label className="field"><span>名称或 ID</span><div className="meta-search-input"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Meta 对象" /></div></label>
        <label className="field"><span>层级</span><select value={level} onChange={(event) => setLevel(event.target.value as MetaAssetLevelFilter)}><option value="all">全部</option><option value="campaign">Campaign</option><option value="ad-group">Ad Set</option><option value="ad">Ad</option></select></label>
        <label className="field"><span>配置状态</span><select value={status} onChange={(event) => setStatus(event.target.value as MetaAssetStatusFilter)}><option value="all">全部</option><option value="ACTIVE">ACTIVE</option><option value="PAUSED">PAUSED</option><option value="unknown">待核验</option></select></label>
      </div>

      <div className="panel table-panel meta-assets-table-panel">
        <div className="panel-heading">
          <div><span className="panel-icon"><Layers3 size={18} /></span><div><h2>Meta 广告对象 <em className="heading-count">{filteredAssets.length}</em></h2><p>configured status 与 effective status 分列展示</p></div></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>对象</th><th>层级</th><th>父级</th><th>Configured</th><th>Effective</th><th>最近同步</th><th>最近操作</th><th>操作</th></tr></thead>
            <tbody>
              {assets === null ? <tr><td colSpan={8}>正在读取本地 Meta 快照…</td></tr> : loadError ? <tr><td colSpan={8}>本地 Meta 快照读取失败：{loadError}</td></tr> : filteredAssets.length === 0 ? <tr><td colSpan={8}>{assets.length === 0 ? "暂无本地快照。请先完成连接检测，再明确点击“只读同步”。" : "当前筛选条件下没有对象。"}</td></tr> : filteredAssets.map((asset) => {
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
                    <td><small>{asset.parentAdGroupId ? `Ad Set ${asset.parentAdGroupId}` : asset.parentCampaignId ? `Campaign ${asset.parentCampaignId}` : "—"}</small></td>
                    <td><span className={configuredStatus === "ACTIVE" ? "status active" : configuredStatus === "PAUSED" ? "status" : "status warning"}>{configuredStatus}</span></td>
                    <td><span className={asset.effectiveStatus?.includes("ACTIVE") ? "status active" : "status warning"}>{asset.effectiveStatus ?? "—"}</span></td>
                    <td>{new Date(asset.syncedAt).toLocaleString()}</td>
                    <td>{operation ? <><span className={operationStatusClass(operation.status)}>{operationStatusLabel(operation.status)}</span><br /><small>{operation.message ?? "—"}</small></> : "—"}</td>
                    <td><div className="row-actions">
                      {operation?.status === "unknown" ? (
                        <button disabled={busy !== null || !canOperateAds} onClick={() => void reconcile(operation)} type="button"><RefreshCcw size={14} /> {busy === `${operation.id}:reconcile` ? "核验中…" : "只读核验"}</button>
                      ) : (
                        <button disabled={!levelStatusReady || !canOperateAds || pending || busy !== null || configuredStatus === "unknown"} onClick={() => void changeStatus(asset)} title={!canOperateAds ? "需要 ads:operate 权限" : !levelStatusReady ? "该层级未获 Meta 手动启停授权" : undefined} type="button">
                          {configuredStatus === "PAUSED" ? <Play size={14} /> : <Pause size={14} />}
                          {actionBusy || pending ? "处理中…" : configuredStatus === "PAUSED" ? "设为 ACTIVE" : "设为 PAUSED"}
                        </button>
                      )}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!statusReady && <div className="alert warning-alert"><CircleAlert size={18} /><span>手动启停尚未开放。请先完成 Meta 接入检测并确认后端 manual-only 安全总开关。</span></div>}
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
