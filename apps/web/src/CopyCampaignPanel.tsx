import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, History, RefreshCcw } from "./ui/icons";
import { deriveCampaignBudgetModes, planCampaignCopy, type ManagedEntityRecord } from "@tk-auto/core";
import { api } from "./api";
import type { CampaignCopyHistoryRecord } from "@tk-auto/core";
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
  generatedAdGroupNames: string[];
  draftPublishAttempts: number;
  draftPublishError: string | null;
}

type LaunchTiming = "disabled" | "immediate" | "scheduled";

// 未来最近的 06:00（本地时区）：现在是 00:10 就给今天早上，已过 06:00 才顺延到次日。
function defaultNextSixOClock(): string {
  const date = new Date();
  date.setHours(6, 0, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type CampaignBudgetKind = "campaign" | "adgroup";

/**
 * 某个系列该出现在哪个入口下。
 *
 * 预算方式未知的系列**两个入口下都出现**：判定依据不足时（系列行没回传预算字段、又
 * 没有子广告组可兜底），用户比我们清楚，藏起来只会让它彻底够不着。代价是它在两边都
 * 露面，因此列表项上必须标注「预算方式未知」。
 */
export function belongsToBudgetKind(
  budgetKind: CampaignBudgetKind,
  campaignId: string,
  modes: {
    optimizedByCampaignId: Map<string, boolean>;
    undeterminedCampaignIds: Set<string>;
  },
): boolean {
  if (modes.undeterminedCampaignIds.has(campaignId)) return true;
  const optimized = modes.optimizedByCampaignId.get(campaignId) === true;
  return budgetKind === "campaign" ? optimized : !optimized;
}

/**
 * 默认停在哪个预算口径。
 *
 * 恒定默认「系列预算」对这些账户是错的：实测建德 142/142、余杭 29/29、般朵 34/34
 * 全是广告组预算，系列预算一条都没有。用户打开就是一张空列表，于是「广告组预算的
 * 系列复制没有入口」——入口在，只是默认那一栏对他永远是空的。
 *
 * 只在一侧为空、另一侧有内容时才替用户选；两侧都有或都没有就别猜，保持原样。
 * 返回 null 表示不改动。
 */
export function pickDefaultBudgetKind(
  cboCount: number,
  adgroupCount: number,
): CampaignBudgetKind | null {
  if (cboCount === 0 && adgroupCount > 0) return "adgroup";
  if (adgroupCount === 0 && cboCount > 0) return "campaign";
  return null;
}

/**
 * 把广告组按所属系列归堆，只保留被选中的那些系列。
 *
 * **「人工接管」的组照样列出来。** ignored 的语义是「不让自动化规则动它」，不是
 * 「不让我手动复制它」——用户是主动点选了这条系列要复制的。此前把 ignored 整片跳过，
 * 一条系列的组要是全被接管过，界面就显示「该系列在当前快照中没有广告组」，而组其实
 * 好好地在那儿（实测余杭账户两条系列各有 1 个组，都在 09-01 04:41 被标成人工接管，
 * 于是那两条系列怎么刷新都复制不出内容）。
 *
 * 复制出来的是全新的组，不继承接管标记，所以复制它们不会绕过任何自动化约定。
 */
export function groupAdGroupsByCampaign(
  entities: readonly ManagedEntityRecord[],
  campaignIds: readonly string[],
): Map<string, ManagedEntityRecord[]> {
  const map = new Map<string, ManagedEntityRecord[]>();
  for (const campaignId of campaignIds) map.set(campaignId, []);
  for (const entity of entities) {
    if (entity.entityType !== "ad-group" || !entity.parentCampaignId) continue;
    const list = map.get(entity.parentCampaignId);
    if (list) list.push(entity);
  }
  return map;
}

/**
 * 排序键：越大越新。
 *
 * `createdAt` 是上游可选字段（`string | null`），真机上并不总有值，所以分两层：
 * 有合法创建时间的一律排在没有的前面（tier 1），彼此按时间比；都没有时回退到
 * externalId——TikTok 的对象 ID 单调递增，数值大的建得晚。两者都拿不到就返回
 * 最小值，让它沉底而不是随机胜出。
 */
function adGroupRecency(entity: ManagedEntityRecord): [number, number] {
  const createdAt = entity.createdAt ? Date.parse(entity.createdAt) : Number.NaN;
  if (Number.isFinite(createdAt)) return [1, createdAt];
  const numericId = Number(entity.externalId);
  return [0, Number.isFinite(numericId) ? numericId : Number.NEGATIVE_INFINITY];
}

/**
 * 系列复制只取一个源广告组——最新建的那个。
 *
 * 复制整个系列时并不需要把源系列的每个组都搬一遍：最新的组通常就是当前在投的
 * 那套定向和素材。原先把所有组列出来默认全选，既是噪音（一个系列十几个组），
 * 又和 N×M 的分配规则对不上（勾了 13 个但只用得到 1 个）。
 */
export function pickLatestAdGroup(
  groups: readonly ManagedEntityRecord[],
): ManagedEntityRecord | null {
  let best: ManagedEntityRecord | null = null;
  let bestKey: [number, number] = [-1, Number.NEGATIVE_INFINITY];
  for (const group of groups) {
    const key = adGroupRecency(group);
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = group;
      bestKey = key;
    }
  }
  return best;
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

/** 从别的面板跳过来时带的预选：落地即选中那条系列，不用再自己找。 */
export interface CampaignCopyPreselection {
  accountId: string;
  campaignIds: string[];
  /** 跳转来源已知的口径。给了就直接切过去，省掉「默认在空 tab」那一步。 */
  budgetKind?: CampaignBudgetKind;
  /** 同一次跳转的标识；变化才重新应用，避免用户改完选择又被覆盖回去。 */
  token: string;
}

/** 复制记录默认铺几行；与扩组记录保持一致，避免长表把提交按钮推到几屏之外。 */
const HISTORY_COLLAPSED_ROWS = 8;

export function CopyCampaignPanel(props: {
  accounts: AccountOption[];
  busy: boolean;
  onError: (message: string | null) => void;
  onCompleted?: () => void | Promise<void>;
  preselection?: CampaignCopyPreselection | null;
}) {
  const { confirm, toast } = useOverlays();
  const platformName = "TikTok";
  const [accountId, setAccountId] = useState<string>(props.accounts[0]?.id ?? "");
  const [entities, setEntities] = useState<ManagedEntityRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [sourceCampaignIds, setSourceCampaignIds] = useState<string[]>([]);
  // 记录「被取消勾选的广告组」而不是「已勾选的」：新勾选的源系列天然默认全选，
  // 取消源系列后也不会残留脏状态。
  // 两个入口：系列预算的系列复制 / 广告组预算的系列复制。原本是一个「只显示系列预算」
  // 的过滤勾选，两类系列可以同时选中，而它们要填的参数根本不同——系列预算的新系列各自
  // 持有一份预算，组预算的系列则由组自己带。混选时那个「系列日预算」框到底作用在谁身上
  // 说不清楚。改成先选口径，列表和参数都跟着口径走。
  const [budgetKind, setBudgetKind] = useState<CampaignBudgetKind>("campaign");
  const [query, setQuery] = useState("");
  // 按当前投放习惯定：一次复制 1 个系列、每个系列 1 个组，组预算 50、出价 7。
  // 原先默认 2 个系列、预算与出价留空（继承源系列），每次都要手改四个框。
  const [campaignCopies, setCampaignCopies] = useState(1);
  const [groupsPerCampaign, setGroupsPerCampaign] = useState(1);
  const [adGroupBudgetText, setAdGroupBudgetText] = useState("50");
  // 默认定时投放：复制出来的系列本来就是要投的，默认「关闭」等于每次都得多点一步，
  // 忘了点就是一批建好却不投的系列躺在后台。定时到最近的 06:00，由 TikTok 原生排期
  // 放行，不会在点下去的瞬间就开始花钱。
  const [launchTiming, setLaunchTiming] = useState<LaunchTiming>("scheduled");
  const [scheduledAt, setScheduledAt] = useState<string>(defaultNextSixOClock);
  const [campaignBudgetText, setCampaignBudgetText] = useState("");
  const [bidText, setBidText] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [stuckTasks, setStuckTasks] = useState<StuckCampaignCopyTask[]>([]);
  const [history, setHistory] = useState<CampaignCopyHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [resettingTaskKey, setResettingTaskKey] = useState<string | null>(null);
  const [publishingTaskKey, setPublishingTaskKey] = useState<string | null>(null);

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

  /**
   * 复制记录。读失败只置空、不弹错——它是辅助信息，不该因为一次读取失败就把
   * 「复制成功了」这件事盖成一条报错。
   */
  const loadHistory = async (id: string) => {
    setHistoryLoading(true);
    try {
      const result = await api.getCampaignCopyHistory([id]);
      setHistory(result.tasks);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (!accountId) return;
    setSourceCampaignIds([]);
    void loadHistory(accountId);
    load(accountId);
    loadStuckTasks(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  /**
   * 发布这条记录留在后台的草稿广告组。
   *
   * 轮询已经会自动补这一步，这个按钮是给自动重试试满之后再点一次用的。只有系列已经建出来
   * 的那类能走通；后台只剩一个「草稿系列」的，服务端会直接说清楚，让人去后台手动处理。
   */
  const publishStuckDraft = async (task: StuckCampaignCopyTask) => {
    const names = task.generatedAdGroupNames.join("、") || "（未记录组名）";
    const confirmed = await confirm({
      title: "发布这条记录的草稿",
      message: `把「${task.campaignName}」下面这些草稿广告组正式发布出去：\n\n${names}\n\n发布后直接投放（组和组里的广告都会开起来）。\n草稿如果已经被手动发布或删除，这里会直接报找不到，不会重复建。`,
      confirmLabel: "发布草稿",
    });
    if (!confirmed) return;
    setPublishingTaskKey(task.taskKey);
    props.onError(null);
    try {
      const result = await api.publishStuckCampaignCopyDraft(task.taskKey);
      toast(result.message, "success");
      loadStuckTasks(accountId);
      void loadHistory(accountId);
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPublishingTaskKey(null);
    }
  };

  const resetStuckTask = async (task: StuckCampaignCopyTask) => {
    const confirmed = await confirm({
      title: "重置该系列复制任务",
      message: `请先在 ${platformName} 广告后台核实「${task.campaignName}」的真实状态（是否已创建成功、是否为无用草稿）。确认无误后重置，才会允许系统重新领取并执行该任务，否则可能产生重复系列。确认重置？`,
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
  // 只数判定明确的。预算方式未知的两个入口下都会列出来，但不计进任何一侧的条数——
  // 否则两个入口的数字加起来会超过实际系列数，看着像重复计算。
  const adgroupCount = useMemo(
    () => allCampaigns.filter((entity) => !isCbo(entity.externalId)
      && !budgetModes.undeterminedCampaignIds.has(entity.externalId)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allCampaigns, budgetModes],
  );
  /**
   * 默认口径跟着账户实情走，而不是恒定停在「系列预算」。
   *
   * 实测这些账户几乎全是广告组预算（建德 142/142、余杭 29/29、般朵 34/34，系列预算
   * 一条都没有）。默认停在系列预算，用户打开就是一张空列表，于是「广告组预算的系列
   * 复制没有入口」——入口在，只是默认那一栏对他永远是空的。
   *
   * 只在用户还没手动选过口径时自动切；一旦点过 tab 就尊重他的选择。
   */
  const kindTouched = useRef(false);
  useEffect(() => {
    if (kindTouched.current) return;
    const next = pickDefaultBudgetKind(cboCount, adgroupCount);
    if (next) setBudgetKind(next);
  }, [cboCount, adgroupCount]);

  /**
   * 应用从别处跳转带来的预选。
   *
   * 按 token 判重而不是按内容：同一次跳转只应用一次，用户落地后自己改了勾选也不会
   * 被这个 effect 覆盖回去。切账户要等 entities 载入完再选，否则勾中的 id 在列表里
   * 还不存在，界面上看不出被选中。
   */
  const appliedPreselection = useRef<string | null>(null);
  const preselection = props.preselection ?? null;
  useEffect(() => {
    if (!preselection || appliedPreselection.current === preselection.token) return;
    if (preselection.accountId !== accountId) {
      setAccountId(preselection.accountId);
      return;
    }
    if (loading) return;
    appliedPreselection.current = preselection.token;
    if (preselection.budgetKind) {
      kindTouched.current = true;
      setBudgetKind(preselection.budgetKind);
    }
    setSourceCampaignIds(preselection.campaignIds);
  }, [preselection, accountId, loading]);

  const visibleCampaigns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return allCampaigns
      .filter((entity) => belongsToBudgetKind(budgetKind, entity.externalId, budgetModes))
      .filter((entity) => !normalized
        || entity.name.toLowerCase().includes(normalized)
        || entity.externalId.toLowerCase().includes(normalized));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCampaigns, budgetKind, query, budgetModes]);

  const adGroupsByCampaign = useMemo(
    () => groupAdGroupsByCampaign(entities, sourceCampaignIds),
    [entities, sourceCampaignIds],
  );

  // 每个源系列只出一个源组：最新建的那个。
  const latestFor = (campaignId: string): ManagedEntityRecord | null =>
    pickLatestAdGroup(adGroupsByCampaign.get(campaignId) ?? []);

  const selectedFor = (campaignId: string) => {
    const latest = latestFor(campaignId);
    return latest ? [latest.externalId] : [];
  };

  const account = props.accounts.find((item) => item.id === accountId);
  const nameOf = (externalId: string) =>
    entities.find((entity) => entity.externalId === externalId)?.name ?? externalId;

  // 分配预览：M/N 组合出来的结果必须在执行前看得见，轮转规则不能是黑盒。
  // 逐个源系列独立规划，名称预留跨源累积，避免两个源系列生成同名副本。
  const preview = useMemo((): { sources: PlannedSource[]; totalGroups: number; skipped: string[] } | { error: string } | null => {
    if (sourceCampaignIds.length === 0) return null;
    try {
      const existingCampaignNames = allCampaigns.map((entity) => entity.name);
      const existingAdGroupNames = entities
        .filter((entity) => entity.entityType === "ad-group")
        .map((entity) => entity.name);
      const reservedCampaignNames: string[] = [];
      const reservedAdGroupNames: string[] = [];
      const sources: PlannedSource[] = [];
      // 取不到源组的系列会被跳过。跳过本身没问题，瞒着用户跳过才有问题：
      // 选了 10 个只复制出 3 个，剩下 7 个去哪了必须写在脸上。
      const skipped: string[] = [];
      let totalGroups = 0;

      for (const campaignId of sourceCampaignIds) {
        const selected = selectedFor(campaignId);
        if (selected.length === 0) {
          skipped.push(nameOf(campaignId));
          continue;
        }
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
      // 选了系列却一个源组都取不到时，必须说清楚为什么。此前这里直接返回 null，
      // 「确认并复制」就静静地灰着，页面上没有任何线索——从「建议重扩系列」一键
      // 带过来的系列尤其容易撞上：它们的组刚被规则关光或还没同步回来。
      if (sourceCampaignIds.length > 0 && sources.length === 0) {
        return {
          error: "选中的系列在当前快照里都没有广告组。刚复制出来的系列要等下一轮同步才会带上组，点右上角「重新读取」刷新；组已被删除的系列复制不出内容。",
        };
      }
      return sources.length === 0 ? null : { sources, totalGroups, skipped };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCampaignIds, adGroupsByCampaign, campaignCopies, groupsPerCampaign, account, allCampaigns, entities]);

  const previewError = preview && "error" in preview ? preview.error : null;
  const previewPlan = preview && !("error" in preview) ? preview : null;

  const toggleCampaign = (externalId: string) => {
    setSourceCampaignIds((current) => current.includes(externalId)
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
    // 组预算只在广告组预算口径下生效。系列预算(CBO)下组不持有独立预算，写进去会触发
    // budget_auto_adjust_initial_budget_not_equal_campaign_budget。
    const adGroupBudget = budgetKind !== "adgroup" || adGroupBudgetText.trim() === ""
      ? null
      : Number(adGroupBudgetText);
    if (adGroupBudget !== null && (!Number.isFinite(adGroupBudget) || adGroupBudget <= 0)) {
      props.onError("广告组日预算必须为正数，或留空以继承源组。");
      return;
    }
    const bid = bidText.trim() === "" ? null : Number(bidText);
    if (bid !== null && (!Number.isFinite(bid) || bid < 0)) {
      props.onError("出价必须为非负数字，或留空继承源组。");
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
        createNewPosts: true,
        campaignBudget,
        adGroupBudget,
        bid,
      });
      const parts = [`已创建 ${result.createdCampaigns} 个系列、${result.createdGroups} 个广告组`];
      if (scheduledStartAt && result.createdCampaigns > 0) {
        parts.push(`已设置 ${platformName} 原生定时投放：${new Date(scheduledStartAt).toLocaleString()}`);
      }
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个重复任务`);
      if (result.failed.length > 0) {
        parts.push(`失败 ${result.failed.length} 个：${result.failed.map((item) => `${item.name}（${item.message}）`).join("；")}`);
      }
      setFeedback(parts.join("；"));
      toast(result.failed.length === 0 ? "系列复制完成" : "系列复制部分失败", result.failed.length === 0 ? "success" : "error");
      load(accountId);
      loadStuckTasks(accountId);
      void loadHistory(accountId);
      void props.onCompleted?.();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const disabled = props.busy || submitting || loading;

  return (
    <div className="panel campaign-copy-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-icon"><Copy size={18} /></span>
          <div>
            <h2>系列复制</h2>
          </div>
        </div>
        <button className="secondary-button compact-button" disabled={disabled} type="button"
          onClick={() => load(accountId)}><RefreshCcw size={14} /> 重新读取</button>
      </div>


      {stuckTasks.length > 0 && (
        <div className="sheet-issues warning campaign-copy-stuck-tasks">
          <strong>{stuckTasks.length} 个任务结果未知，已暂停自动重试</strong>
          <span>网络中断导致系统无法确认这些任务是否已在 {platformName} 侧创建成功，为避免产生重复系列，已停止整批自动重试。轮询查到系列已经建出来、只差组没发布的，会自动补发布（最多试 3 次）；试满或系列压根没建出来的，请先到 {platformName} 广告后台核实真实状态，再发布草稿或重置。</span>
          <div className="table-wrap">
            <table>
              <thead><tr><th>新系列名称</th><th>源系列 ID</th><th>最近更新</th><th>已生成的系列 ID</th><th>自动补发布</th><th></th></tr></thead>
              <tbody>
                {stuckTasks.map((task) => (
                  <tr key={task.taskKey}>
                    <td>{task.campaignName}</td>
                    <td>{task.sourceCampaignId}</td>
                    <td>{new Date(task.updatedAt).toLocaleString()}</td>
                    <td>{task.generatedCampaignId ?? "（未生成）"}</td>
                    <td title={task.draftPublishError ?? undefined}>
                      {task.draftPublishAttempts === 0
                        ? "—"
                        : `试过 ${task.draftPublishAttempts} 次：${task.draftPublishError ?? "原因未记录"}`}
                    </td>
                    <td>
                      {task.generatedAdGroupNames.length > 0 && <button className="secondary-button compact-button"
                        disabled={disabled || publishingTaskKey !== null}
                        onClick={() => void publishStuckDraft(task)} type="button">
                        {publishingTaskKey === task.taskKey ? "发布中…" : "发布草稿"}
                      </button>}
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
        {/* 预算框跟着口径换，而不是把不适用的那个禁用掉摆在那儿——广告组预算口径下
            用户要设的是组预算，此前这里只有一个灰掉的「系列日预算」，等于没有入口。 */}
        {budgetKind === "campaign"
          ? <label className="field"><span>系列日预算（留空继承源系列）</span>
              <input disabled={disabled} min="0.01" step="0.01" type="number" value={campaignBudgetText}
                onChange={(event) => setCampaignBudgetText(event.target.value)} />
              <small>每个新系列各自持有这一份预算。</small>
            </label>
          : <label className="field"><span>广告组日预算（留空继承源组）</span>
              <input disabled={disabled} min="0.01" step="0.01" type="number" value={adGroupBudgetText}
                onChange={(event) => setAdGroupBudgetText(event.target.value)} />
              <small>每个新广告组各自持有这一份预算；新系列不带系列预算。</small>
            </label>}
        <label className="field"><span>出价（留空继承源组）</span>
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
            ? <label className="campaign-copy-timing-when"><input disabled={disabled} type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /><small>新系列将以开启状态发布，并由 TikTok 在设定时间原生开始投放。默认最近的早上 06:00（未到 06:00 就是今天），可改。</small></label>
            : <small>一次会创建多个系列，默认关闭以避免误花费。</small>}
        </div>
      </div>

      <div className="campaign-copy-sources">
        {/* 两个入口。切换会清空已选：两类系列要填的参数不同，带着上一个口径的选择过来
            只会让「系列日预算」作用在说不清的对象上。 */}
        <div className="campaign-copy-kind-tabs" role="group" aria-label="选择系列复制的预算口径">
          <button aria-pressed={budgetKind === "campaign"} className={budgetKind === "campaign" ? "active" : ""} disabled={disabled}
            onClick={() => { kindTouched.current = true; setBudgetKind("campaign"); setSourceCampaignIds([]); }} type="button">
            <strong>系列预算的系列复制</strong>
            <span>每个新系列各自持有一份系列预算（共 {cboCount} 条）</span>
          </button>
          <button aria-pressed={budgetKind === "adgroup"} className={budgetKind === "adgroup" ? "active" : ""} disabled={disabled}
            onClick={() => { kindTouched.current = true; setBudgetKind("adgroup"); setSourceCampaignIds([]); setCampaignBudgetText(""); }} type="button">
            <strong>广告组预算的系列复制</strong>
            <span>预算跟着广告组走，新系列不带系列预算（共 {adgroupCount} 条）</span>
          </button>
        </div>
        <div className="campaign-copy-source-toolbar">
          <strong>源推广系列（可多选，已选 {sourceCampaignIds.length}）</strong>
          <input aria-label="搜索推广系列" disabled={disabled} placeholder="搜索系列名称或 ID"
            value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="secondary-button compact-button" disabled={disabled} type="button"
            onClick={() => setSourceCampaignIds(visibleCampaigns.map((entity) => entity.externalId))}>全选当前结果</button>
          <button className="secondary-button compact-button" disabled={disabled} type="button"
            onClick={() => setSourceCampaignIds([])}>清空</button>
        </div>
        {visibleCampaigns.length === 0
          ? <p className="target-account-empty">
              {allCampaigns.length === 0
                ? "该账户在当前同步快照中没有推广系列，请先执行只读同步。"
                : query.trim()
                  ? "没有匹配的推广系列。"
                  : budgetKind === "campaign"
                    ? `该账户没有系列预算的推广系列${adgroupCount > 0 ? `（另有 ${adgroupCount} 条广告组预算的系列，切到上方另一个入口）` : ""}。`
                    : `该账户没有广告组预算的推广系列${cboCount > 0 ? `（另有 ${cboCount} 条系列预算的系列，切到上方另一个入口）` : ""}。`}
            </p>
          : <div className="target-account-grid">
            {visibleCampaigns.map((entity) => {
              // 选中后直接告知取的是哪个组，省掉一整块广告组勾选区。
              const picked = sourceCampaignIds.includes(entity.externalId)
                ? pickLatestAdGroup(adGroupsByCampaign.get(entity.externalId) ?? [])
                : null;
              return (
                <label key={entity.externalId}>
                  <input checked={sourceCampaignIds.includes(entity.externalId)} disabled={disabled}
                    onChange={() => toggleCampaign(entity.externalId)} type="checkbox" />
                  <span>{entity.name}</span>
                  <small>{isCbo(entity.externalId) ? "系列预算" : "广告组预算"}
                    {budgetModes.undeterminedCampaignIds.has(entity.externalId) ? " · 预算方式未知" : ""}
                    {picked ? ` · 源组：${picked.name}` : ""}
                    {sourceCampaignIds.includes(entity.externalId) && !picked ? " · 快照中暂无广告组" : ""}</small>
                </label>
              );
            })}
          </div>}
        {budgetKind === "campaign" && cboCount === 0 && allCampaigns.length > 0 && (
          <p className="target-account-empty">当前账户没有识别到系列预算的推广系列。若与 TikTok 后台不符，请先执行一次只读同步。</p>
        )}
      </div>

      {/*
        这里原先是「参与分配的广告组（默认全选，可逐个取消）」：每个选中的系列
        渲染一块勾选区，一个系列十几个组就是十几个复选框。它有两个问题——
        选三个系列页面就长到 2400px 以上；而且勾选数和 N×M 的分配规则对不上，
        勾了 13 个实际只用 1 个，多余的静默丢弃。既然每个系列只取最新的那个组，
        这块区域整个删掉，源组名直接标在上面的系列行里。
      */}

      {previewError && <div className="sheet-issues warning"><strong>无法生成分配方案</strong><span>{previewError}</span></div>}

      {previewPlan && (
        <div className="campaign-copy-preview">
          <strong>
            分配预览 · {previewPlan.sources.length} 个源系列 →
            {" "}{previewPlan.sources.reduce((sum, item) => sum + item.campaigns.length, 0)} 个新系列 /
            共 {previewPlan.totalGroups} 个广告组
          </strong>
          {previewPlan.skipped.length > 0 && (
            <div className="tk-callout warn">
              <b>{previewPlan.skipped.length} 个系列不会被复制</b>
              <span>它们在当前快照里没有广告组：{previewPlan.skipped.join("、")}。刚复制出来的系列要等下一轮同步，点右上角「重新读取」刷新。</span>
            </div>
          )}
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

      {/* 复制记录。此前复制完只有一句即时提示，刷新就没了——想知道昨天复制过什么、
          生成了哪些系列，只能去 TikTok 后台翻。 */}
      <section className="expand-history">
        <header className="expand-history-head">
          <span><History size={15} /> 复制记录</span>
          <div className="expand-history-actions">
            {history.length > 0 && <span className="expand-history-count">{history.length} 条</span>}
            <button className="secondary-button compact-button" disabled={historyLoading}
              onClick={() => void loadHistory(accountId)} type="button">
              <RefreshCcw size={14} /> {historyLoading ? "读取中" : "刷新"}
            </button>
          </div>
        </header>
        {history.length === 0
          ? <p className="expand-account-empty">{historyLoading ? "读取中…" : "还没有复制记录。"}</p>
          : <>
              <div className="table-wrap expand-table expand-history-table"><table>
                <thead><tr><th>时间</th><th>源系列</th><th>结果</th><th className="expand-num">生成组数</th></tr></thead>
                <tbody>
                  {(historyExpanded ? history : history.slice(0, HISTORY_COLLAPSED_ROWS)).map((task) => (
                    <tr key={task.taskKey}>
                      <td className="expand-muted">{new Date(task.updatedAt).toLocaleString()}</td>
                      <td className="expand-name">{task.campaignName}</td>
                      <td>
                        {/* 「结果未知」排在最前面的语义：它是唯一需要人动手的那类。 */}
                        {task.uncertain
                          ? <span className="status warning">结果未知</span>
                          : task.status === "succeeded"
                            ? <span className="status active">已完成</span>
                            : <span className="status">进行中</span>}
                      </td>
                      <td className="expand-num">{task.generatedAdGroupIds.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              {history.length > HISTORY_COLLAPSED_ROWS && (
                <button className="secondary-button compact-button"
                  onClick={() => setHistoryExpanded((value) => !value)} type="button">
                  {historyExpanded ? "收起" : `展开全部 ${history.length} 条`}
                </button>
              )}
            </>}
      </section>

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

