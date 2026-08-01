import { useEffect, useMemo, useState } from "react";
import { Copy, RefreshCcw } from "lucide-react";
import { deriveCampaignBudgetModes, planCampaignCopy, type ManagedEntityRecord } from "@tk-auto/core";
import { api } from "./api";
import { useOverlays } from "./ui/overlays";

interface AccountOption {
  id: string;
  displayName: string;
  timezone?: string;
}

interface PlannedSource {
  sourceCampaignId: string;
  sourceCampaignName: string;
  campaigns: Array<{ campaignName: string; groups: Array<{ sourceAdGroupId: string; name: string }> }>;
}

interface StuckCampaignCopyTask {
  taskKey: string;
  accountId: string;
  sourceCampaignId: string;
  campaignName: string;
  claimedAt: string;
  updatedAt: string;
  generatedCampaignId: string | null;
  generatedAdGroupIds: string[];
}

type LaunchTiming = "disabled" | "immediate" | "scheduled";

function defaultNextDaySix(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(6, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface ResolvedCampaignCopyLaunchTiming {
  initialStatus: "enabled" | "disabled";
  scheduledStartAt: string | null;
}

/**
 * 把「关闭 / 立即投放 / 定时投放」三选一，翻译成服务端需要的
 * initialStatus + scheduledStartAt。定时投放下服务端本来就会把 initialStatus
 * 强制覆盖成 enabled（新系列以开启状态发布，由 TikTok 原生到点开始投放），
 * 这里显式给出一致的值，避免前后端语义对不上。
 */
export function resolveCampaignCopyLaunchTiming(
  timing: LaunchTiming,
  scheduledAtLocal: string,
  now = new Date(),
): { ok: true; value: ResolvedCampaignCopyLaunchTiming } | { ok: false; error: string } {
  if (timing !== "scheduled") {
    return { ok: true, value: { initialStatus: timing === "immediate" ? "enabled" : "disabled", scheduledStartAt: null } };
  }
  const when = new Date(scheduledAtLocal);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: "请填写有效的定时投放时间。" };
  }
  if (when.getTime() <= now.getTime()) {
    return { ok: false, error: "定时投放时间必须晚于当前时间。" };
  }
  return { ok: true, value: { initialStatus: "enabled", scheduledStartAt: when.toISOString() } };
}

export function CopyCampaignPanel(props: {
  accounts: AccountOption[];
  busy: boolean;
  onError: (message: string | null) => void;
}) {
  const { confirm, toast } = useOverlays();
  const [accountId, setAccountId] = useState<string>(props.accounts[0]?.id ?? "");
  const [entities, setEntities] = useState<ManagedEntityRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [sourceCampaignIds, setSourceCampaignIds] = useState<string[]>([]);
  // 记录「被取消勾选的广告组」而不是「已勾选的」：新勾选的源系列天然默认全选，
  // 取消源系列后也不会残留脏状态。
  const [excludedAdGroupIds, setExcludedAdGroupIds] = useState<string[]>([]);
  const [onlyCampaignBudget, setOnlyCampaignBudget] = useState(true);
  const [query, setQuery] = useState("");
  const [campaignCopies, setCampaignCopies] = useState(2);
  const [groupsPerCampaign, setGroupsPerCampaign] = useState(1);
  const [launchTiming, setLaunchTiming] = useState<LaunchTiming>("disabled");
  const [scheduledAt, setScheduledAt] = useState<string>(defaultNextDaySix);
  const [campaignBudgetText, setCampaignBudgetText] = useState("");
  const [bidText, setBidText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [stuckTasks, setStuckTasks] = useState<StuckCampaignCopyTask[]>([]);
  const [resettingTaskKey, setResettingTaskKey] = useState<string | null>(null);

  const load = (id: string) => {
    setLoading(true);
    api.getManagedEntities(id)
      .then(setEntities)
      .catch((cause: unknown) => props.onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  };

  const loadStuckTasks = (id: string) => {
    api.listStuckCampaignCopyTasks(id)
      .then(setStuckTasks)
      .catch((cause: unknown) => props.onError(cause instanceof Error ? cause.message : String(cause)));
  };

  useEffect(() => {
    if (!accountId) return;
    setSourceCampaignIds([]);
    setExcludedAdGroupIds([]);
    load(accountId);
    loadStuckTasks(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const resetStuckTask = async (task: StuckCampaignCopyTask) => {
    const confirmed = await confirm({
      title: "重置该系列复制任务",
      message: `请先在 TikTok 广告后台核实「${task.campaignName}」的真实状态（是否已创建成功、是否为无用草稿）。确认无误后重置，才会允许系统重新领取并执行该任务，否则可能产生重复系列。确认重置？`,
      confirmLabel: "已核实，确认重置",
      danger: true,
    });
    if (!confirmed) return;
    setResettingTaskKey(task.taskKey);
    props.onError(null);
    try {
      await api.resetCampaignCopyTask(accountId, task.taskKey);
      toast("已重置，可重新执行", "success");
      loadStuckTasks(accountId);
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResettingTaskKey(null);
    }
  };

  // 系列列表接口不一定回传系列自身的预算字段，因此以广告组携带的父系列信息兜底。
  const budgetModes = useMemo(() => deriveCampaignBudgetModes(entities), [entities]);
  const isCbo = (externalId: string) => budgetModes.optimizedByCampaignId.get(externalId) === true;

  const allCampaigns = useMemo(
    () => entities.filter((entity) => entity.entityType === "campaign" && !entity.ignored),
    [entities],
  );
  const cboCount = useMemo(
    () => allCampaigns.filter((entity) => isCbo(entity.externalId)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCampaigns, budgetModes],
  );
  const visibleCampaigns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return allCampaigns
      .filter((entity) => !onlyCampaignBudget || isCbo(entity.externalId))
      .filter((entity) => !normalized
        || entity.name.toLowerCase().includes(normalized)
        || entity.externalId.toLowerCase().includes(normalized));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCampaigns, onlyCampaignBudget, query, budgetModes]);

  const adGroupsByCampaign = useMemo(() => {
    const map = new Map<string, ManagedEntityRecord[]>();
    for (const campaignId of sourceCampaignIds) map.set(campaignId, []);
    for (const entity of entities) {
      if (entity.entityType !== "ad-group" || entity.ignored || !entity.parentCampaignId) continue;
      const list = map.get(entity.parentCampaignId);
      if (list) list.push(entity);
    }
    return map;
  }, [entities, sourceCampaignIds]);

  const selectedFor = (campaignId: string) =>
    (adGroupsByCampaign.get(campaignId) ?? [])
      .map((entity) => entity.externalId)
      .filter((id) => !excludedAdGroupIds.includes(id));

  const account = props.accounts.find((item) => item.id === accountId);
  const nameOf = (externalId: string) =>
    entities.find((entity) => entity.externalId === externalId)?.name ?? externalId;

  // 分配预览：M/N 组合出来的结果必须在执行前看得见，轮转规则不能是黑盒。
  // 逐个源系列独立规划，名称预留跨源累积，避免两个源系列生成同名副本。
  const preview = useMemo((): { sources: PlannedSource[]; totalGroups: number } | { error: string } | null => {
    if (sourceCampaignIds.length === 0) return null;
    try {
      const existingCampaignNames = allCampaigns.map((entity) => entity.name);
      const existingAdGroupNames = entities
        .filter((entity) => entity.entityType === "ad-group")
        .map((entity) => entity.name);
      const reservedCampaignNames: string[] = [];
      const reservedAdGroupNames: string[] = [];
      const sources: PlannedSource[] = [];
      let totalGroups = 0;

      for (const campaignId of sourceCampaignIds) {
        const selected = selectedFor(campaignId);
        if (selected.length === 0) continue;
        const groupNames = new Map(
          (adGroupsByCampaign.get(campaignId) ?? []).map((entity) => [entity.externalId, entity.name]),
        );
        const plan = planCampaignCopy({
          sourceCampaignName: nameOf(campaignId),
          sourceAdGroupNames: groupNames,
          sourceAdGroupIds: selected,
          campaignCopies,
          groupsPerCampaign,
          at: new Date(),
          ...(account?.timezone ? { timeZone: account.timezone } : {}),
          existingCampaignNames: [...existingCampaignNames, ...reservedCampaignNames],
          existingAdGroupNames: [...existingAdGroupNames, ...reservedAdGroupNames],
        });
        for (const campaign of plan.campaigns) {
          reservedCampaignNames.push(campaign.campaignName);
          for (const group of campaign.groups) reservedAdGroupNames.push(group.name);
        }
        totalGroups += plan.totalGroups;
        sources.push({
          sourceCampaignId: campaignId,
          sourceCampaignName: nameOf(campaignId),
          campaigns: plan.campaigns,
        });
      }
      return sources.length === 0 ? null : { sources, totalGroups };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCampaignIds, excludedAdGroupIds, adGroupsByCampaign, campaignCopies, groupsPerCampaign, account, allCampaigns, entities]);

  const previewError = preview && "error" in preview ? preview.error : null;
  const previewPlan = preview && !("error" in preview) ? preview : null;
  const anySourceIsCbo = sourceCampaignIds.some((id) => isCbo(id));

  const toggleCampaign = (externalId: string) => {
    setSourceCampaignIds((current) => current.includes(externalId)
      ? current.filter((id) => id !== externalId)
      : [...current, externalId]);
  };
  const toggleAdGroup = (externalId: string) => {
    setExcludedAdGroupIds((current) => current.includes(externalId)
      ? current.filter((id) => id !== externalId)
      : [...current, externalId]);
  };

  const submit = async () => {
    if (!previewPlan) return;
    const campaignBudget = campaignBudgetText.trim() === "" ? null : Number(campaignBudgetText);
    if (campaignBudget !== null && (!Number.isFinite(campaignBudget) || campaignBudget <= 0)) {
      props.onError("系列日预算必须为正数，或留空以继承源系列。");
      return;
    }
    const bid = bidText.trim() === "" ? null : Number(bidText);
    if (bid !== null && (!Number.isFinite(bid) || bid < 0)) {
      props.onError("出价必须为非负数字，或留空继承源系列。");
      return;
    }
    const totalCampaigns = previewPlan.sources.reduce((sum, item) => sum + item.campaigns.length, 0);
    const timing = resolveCampaignCopyLaunchTiming(launchTiming, scheduledAt);
    if (!timing.ok) {
      props.onError(timing.error);
      return;
    }
    const { initialStatus, scheduledStartAt } = timing.value;
    // 立即投放是不可逆的真实写入，二次确认避免误点；定时投放在 TikTok 侧到点
    // 才会真正开始花费，与其他面板的既有约定一致，不额外二次确认。
    if (launchTiming === "immediate") {
      const confirmed = await confirm({
        title: "立即投放确认",
        message: `将创建 ${totalCampaigns} 个推广系列、共 ${previewPlan.totalGroups} 个广告组，并【立即开始投放】。确认？`,
        confirmLabel: "确认立即投放",
        danger: true,
      });
      if (!confirmed) return;
    }
    setSubmitting(true);
    setFeedback(null);
    props.onError(null);
    try {
      const result = await api.copyCampaign({
        accountId,
        sources: previewPlan.sources.map((item) => ({
          sourceCampaignId: item.sourceCampaignId,
          sourceAdGroupIds: selectedFor(item.sourceCampaignId),
        })),
        campaignCopies,
        groupsPerCampaign,
        initialStatus,
        scheduledStartAt,
        campaignBudget,
        bid,
      });
      const parts = [`已创建 ${result.createdCampaigns} 个系列、${result.createdGroups} 个广告组`];
      if (scheduledStartAt && result.createdCampaigns > 0) {
        parts.push(`已设置 TikTok 原生定时投放：${new Date(scheduledStartAt).toLocaleString()}`);
      }
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个重复任务`);
      if (result.failed.length > 0) {
        parts.push(`失败 ${result.failed.length} 个：${result.failed.map((item) => `${item.name}（${item.message}）`).join("；")}`);
      }
      setFeedback(parts.join("；"));
      toast(result.failed.length === 0 ? "系列复制完成" : "系列复制部分失败", result.failed.length === 0 ? "success" : "error");
      load(accountId);
      loadStuckTasks(accountId);
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = props.busy || submitting || loading;
  const hiddenCount = allCampaigns.length - visibleCampaigns.length;

  return (
    <div className="panel campaign-copy-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-icon"><Copy size={18} /></span>
          <div>
            <h2>系列复制</h2>
            <p>把推广系列复制成多个新系列，并决定每个新系列放几个广告组。系列预算的系列请用这里放量——往同一个系列里加广告组只会摊薄原有预算。</p>
          </div>
        </div>
        <button className="secondary-button compact-button" disabled={disabled} type="button"
          onClick={() => load(accountId)}><RefreshCcw size={14} /> 重新读取</button>
      </div>

      {stuckTasks.length > 0 && (
        <div className="sheet-issues warning campaign-copy-stuck-tasks">
          <strong>{stuckTasks.length} 个任务结果未知，已暂停自动重试</strong>
          <span>网络中断导致系统无法确认这些任务是否已在 TikTok 侧创建成功，为避免产生重复系列，已停止自动重试。请先到 TikTok 广告后台核实真实状态，再逐个重置。</span>
          <div className="table-wrap">
            <table>
              <thead><tr><th>新系列名称</th><th>源系列 ID</th><th>最近更新</th><th>已生成的系列 ID</th><th></th></tr></thead>
              <tbody>
                {stuckTasks.map((task) => (
                  <tr key={task.taskKey}>
                    <td>{task.campaignName}</td>
                    <td>{task.sourceCampaignId}</td>
                    <td>{new Date(task.updatedAt).toLocaleString()}</td>
                    <td>{task.generatedCampaignId ?? "（未生成）"}</td>
                    <td>
                      <button className="secondary-button compact-button" disabled={disabled || resettingTaskKey === task.taskKey}
                        onClick={() => void resetStuckTask(task)} type="button">
                        {resettingTaskKey === task.taskKey ? "重置中…" : "已核实，重置"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="form-grid">
        <label className="field"><span>账户</span>
          <select disabled={disabled} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {props.accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
        <label className="field"><span>生成几个系列（N）</span>
          <input disabled={disabled} max={20} min={1} type="number" value={campaignCopies}
            onChange={(event) => setCampaignCopies(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} />
          <small>每个源系列各生成这么多个副本。</small>
        </label>
        <label className="field"><span>每个系列几个广告组（M）</span>
          <input disabled={disabled} max={20} min={1} type="number" value={groupsPerCampaign}
            onChange={(event) => setGroupsPerCampaign(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} />
          <small>勾选的源广告组按顺序轮转填入。</small>
        </label>
        <label className="field"><span>系列日预算（留空继承源系列）</span>
          <input disabled={disabled || !anySourceIsCbo} min="0.01" step="0.01" type="number" value={campaignBudgetText}
            onChange={(event) => setCampaignBudgetText(event.target.value)} />
          <small>{anySourceIsCbo ? "每个新系列各自持有这一份预算。" : "所选源系列使用广告组预算，此处不适用。"}</small>
        </label>
        <label className="field"><span>出价（留空继承源系列）</span>
          <input disabled={disabled} min="0" step="0.01" type="number" value={bidText}
            onChange={(event) => setBidText(event.target.value)} />
        </label>
        <div className="field campaign-copy-timing-field">
          <span>创建时间</span>
          <div className="campaign-copy-timing-modes" role="group" aria-label="创建时间">
            <button aria-pressed={launchTiming === "disabled"} className={launchTiming === "disabled" ? "active" : ""} disabled={disabled} onClick={() => setLaunchTiming("disabled")} type="button">关闭（默认）</button>
            <button aria-pressed={launchTiming === "immediate"} className={launchTiming === "immediate" ? "active" : ""} disabled={disabled} onClick={() => setLaunchTiming("immediate")} type="button">立即投放</button>
            <button aria-pressed={launchTiming === "scheduled"} className={launchTiming === "scheduled" ? "active" : ""} disabled={disabled} onClick={() => setLaunchTiming("scheduled")} type="button">定时投放</button>
          </div>
          {launchTiming === "scheduled"
            ? <label className="campaign-copy-timing-when"><input disabled={disabled} type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /><small>新系列将以开启状态发布，并由 TikTok 在设定时间原生开始投放。默认次日 06:00，可改。</small></label>
            : <small>一次会创建多个系列，默认关闭以避免误花费。</small>}
        </div>
      </div>

      <div className="campaign-copy-sources">
        <div className="campaign-copy-source-toolbar">
          <strong>源推广系列（可多选，已选 {sourceCampaignIds.length}）</strong>
          <label className="campaign-copy-filter">
            <input checked={onlyCampaignBudget} disabled={disabled} type="checkbox"
              onChange={(event) => setOnlyCampaignBudget(event.target.checked)} />
            <span>只显示系列预算（共 {cboCount} 条）</span>
          </label>
          <input aria-label="搜索推广系列" disabled={disabled} placeholder="搜索系列名称或 ID"
            value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="secondary-button compact-button" disabled={disabled} type="button"
            onClick={() => setSourceCampaignIds(visibleCampaigns.map((entity) => entity.externalId))}>全选当前结果</button>
          <button className="secondary-button compact-button" disabled={disabled} type="button"
            onClick={() => { setSourceCampaignIds([]); setExcludedAdGroupIds([]); }}>清空</button>
        </div>
        {visibleCampaigns.length === 0
          ? <p className="target-account-empty">
              {allCampaigns.length === 0
                ? "该账户在当前同步快照中没有推广系列，请先执行只读同步。"
                : onlyCampaignBudget
                  ? `没有系列预算的推广系列${hiddenCount > 0 ? `（已隐藏 ${hiddenCount} 条广告组预算的系列）` : ""}。取消勾选上方过滤即可看到全部。`
                  : "没有匹配的推广系列。"}
            </p>
          : <div className="target-account-grid">
            {visibleCampaigns.map((entity) => (
              <label key={entity.externalId}>
                <input checked={sourceCampaignIds.includes(entity.externalId)} disabled={disabled}
                  onChange={() => toggleCampaign(entity.externalId)} type="checkbox" />
                <span>{entity.name}</span>
                <small>{isCbo(entity.externalId) ? "系列预算" : "广告组预算"}
                  {budgetModes.undeterminedCampaignIds.has(entity.externalId) ? " · 预算方式未知" : ""}</small>
              </label>
            ))}
          </div>}
        {!onlyCampaignBudget && hiddenCount === 0 && cboCount === 0 && allCampaigns.length > 0 && (
          <p className="target-account-empty">当前账户没有识别到系列预算的推广系列。若与 TikTok 后台不符，请先执行一次只读同步。</p>
        )}
      </div>

      {selectedCampaignsHaveGroups(adGroupsByCampaign) && (
        <div className="campaign-copy-sources">
          <strong>参与分配的广告组（默认全选，可逐个取消）</strong>
          {[...adGroupsByCampaign].map(([campaignId, list]) => (
            <div className="campaign-copy-group-block" key={campaignId}>
              <em>{nameOf(campaignId)}</em>
              {list.length === 0
                ? <p className="target-account-empty">该系列在当前快照中没有广告组。</p>
                : <div className="target-account-grid">
                  {list.map((entity) => (
                    <label key={entity.externalId}>
                      <input checked={!excludedAdGroupIds.includes(entity.externalId)} disabled={disabled}
                        onChange={() => toggleAdGroup(entity.externalId)} type="checkbox" />
                      <span>{entity.name}</span>
                      <small>{entity.status === "enabled" ? "投放中" : "已关闭"}</small>
                    </label>
                  ))}
                </div>}
            </div>
          ))}
        </div>
      )}

      {previewError && <div className="sheet-issues warning"><strong>无法生成分配方案</strong><span>{previewError}</span></div>}

      {previewPlan && (
        <div className="campaign-copy-preview">
          <strong>
            分配预览 · {previewPlan.sources.length} 个源系列 →
            {" "}{previewPlan.sources.reduce((sum, item) => sum + item.campaigns.length, 0)} 个新系列 /
            共 {previewPlan.totalGroups} 个广告组
          </strong>
          <div className="table-wrap">
            <table>
              <thead><tr><th>源系列</th><th>新推广系列</th><th>包含的广告组</th></tr></thead>
              <tbody>
                {previewPlan.sources.flatMap((source) => source.campaigns.map((campaign, index) => (
                  <tr key={campaign.campaignName}>
                    {index === 0
                      ? <td rowSpan={source.campaigns.length}>{source.sourceCampaignName}</td>
                      : null}
                    <td>{campaign.campaignName}</td>
                    <td>{campaign.groups.map((group) => (
                      <small key={group.name}>
                        {group.name}<em>（源：{nameOf(group.sourceAdGroupId)}）</em>
                      </small>
                    ))}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {feedback && <div className="preset-save-feedback"><strong>执行结果</strong><span>{feedback}</span></div>}

      <div className="form-actions">
        <button className="primary-button" disabled={disabled || !previewPlan} onClick={() => void submit()} type="button">
          {submitting
            ? "正在复制…"
            : `确认并复制${previewPlan ? `（${previewPlan.sources.reduce((sum, item) => sum + item.campaigns.length, 0)} 个系列）` : ""}`}
        </button>
      </div>
    </div>
  );
}

function selectedCampaignsHaveGroups(map: Map<string, ManagedEntityRecord[]>): boolean {
  return map.size > 0;
}
