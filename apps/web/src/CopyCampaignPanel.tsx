import { useEffect, useMemo, useState } from "react";
import { Copy, RefreshCcw } from "lucide-react";
import { planCampaignCopy, type ManagedEntityRecord } from "@tk-auto/core";
import { api } from "./api";
import { useOverlays } from "./ui/overlays";

interface AccountOption {
  id: string;
  displayName: string;
  timezone?: string;
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
  const [sourceCampaignId, setSourceCampaignId] = useState("");
  const [selectedAdGroupIds, setSelectedAdGroupIds] = useState<string[]>([]);
  const [campaignCopies, setCampaignCopies] = useState(2);
  const [groupsPerCampaign, setGroupsPerCampaign] = useState(1);
  const [initialStatus, setInitialStatus] = useState<"enabled" | "disabled">("disabled");
  const [campaignBudgetText, setCampaignBudgetText] = useState("");
  const [bidText, setBidText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    setSourceCampaignId("");
    setSelectedAdGroupIds([]);
    api.getManagedEntities(accountId)
      .then(setEntities)
      .catch((cause: unknown) => props.onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const campaigns = useMemo(
    () => entities.filter((entity) => entity.entityType === "campaign" && !entity.ignored),
    [entities],
  );
  const sourceCampaign = campaigns.find((entity) => entity.externalId === sourceCampaignId);
  const adGroups = useMemo(
    () => entities.filter((entity) => entity.entityType === "ad-group"
      && !entity.ignored
      && entity.parentCampaignId === sourceCampaignId),
    [entities, sourceCampaignId],
  );

  // 选中一个新的源系列时默认全选它的广告组。
  useEffect(() => {
    setSelectedAdGroupIds(adGroups.map((entity) => entity.externalId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCampaignId, entities]);

  const account = props.accounts.find((item) => item.id === accountId);

  // 分配预览：M/N 组合出来的结果必须在执行前看得见，轮转规则不能是黑盒。
  const preview = useMemo(() => {
    if (!sourceCampaign || selectedAdGroupIds.length === 0) return null;
    try {
      return planCampaignCopy({
        sourceCampaignName: sourceCampaign.name,
        sourceAdGroupNames: new Map(adGroups.map((entity) => [entity.externalId, entity.name])),
        sourceAdGroupIds: selectedAdGroupIds,
        campaignCopies,
        groupsPerCampaign,
        at: new Date(),
        ...(account?.timezone ? { timeZone: account.timezone } : {}),
        existingCampaignNames: campaigns.map((entity) => entity.name),
        existingAdGroupNames: entities
          .filter((entity) => entity.entityType === "ad-group")
          .map((entity) => entity.name),
      });
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) } as const;
    }
  }, [sourceCampaign, adGroups, selectedAdGroupIds, campaignCopies, groupsPerCampaign, account, campaigns, entities]);

  const previewError = preview && "error" in preview ? preview.error : null;
  const previewPlan = preview && !("error" in preview) ? preview : null;
  const sourceIsCbo = Boolean(sourceCampaign?.campaignBudgetOptimized);

  const toggleAdGroup = (externalId: string) => {
    setSelectedAdGroupIds((current) => current.includes(externalId)
      ? current.filter((id) => id !== externalId)
      : [...current, externalId]);
  };

  const submit = async () => {
    if (!sourceCampaignId || selectedAdGroupIds.length === 0 || !previewPlan) return;
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
    if (initialStatus === "enabled") {
      const confirmed = await confirm({
        title: "立即投放确认",
        message: `将创建 ${previewPlan.campaigns.length} 个推广系列、共 ${previewPlan.totalGroups} 个广告组，并【立即开始投放】。确认？`,
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
        sourceCampaignId,
        sourceAdGroupIds: selectedAdGroupIds,
        campaignCopies,
        groupsPerCampaign,
        initialStatus,
        campaignBudget,
        bid,
      });
      const parts = [`已创建 ${result.createdCampaigns} 个系列、${result.createdGroups} 个广告组`];
      if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个重复任务`);
      if (result.failed.length > 0) {
        parts.push(`失败 ${result.failed.length} 个：${result.failed.map((item) => `${item.name}（${item.message}）`).join("；")}`);
      }
      setFeedback(parts.join("；"));
      toast(result.failed.length === 0 ? "系列复制完成" : "系列复制部分失败", result.failed.length === 0 ? "success" : "error");
      const refreshed = await api.getManagedEntities(accountId);
      setEntities(refreshed);
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
            <p>把一个推广系列复制成多个新系列，并决定每个新系列里放几个广告组。系列预算的系列请用这里放量——往同一个系列里加广告组只会摊薄原有预算。</p>
          </div>
        </div>
        <button className="secondary-button compact-button" disabled={disabled} type="button" onClick={() => {
          setLoading(true);
          api.getManagedEntities(accountId).then(setEntities)
            .catch((cause: unknown) => props.onError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setLoading(false));
        }}><RefreshCcw size={14} /> 重新读取</button>
      </div>

      <div className="form-grid">
        <label className="field"><span>账户</span>
          <select disabled={disabled} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {props.accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
        <label className="field"><span>源推广系列</span>
          <select disabled={disabled} value={sourceCampaignId} onChange={(event) => setSourceCampaignId(event.target.value)}>
            <option value="">请选择</option>
            {campaigns.map((entity) => (
              <option key={entity.externalId} value={entity.externalId}>
                {entity.name}{entity.campaignBudgetOptimized ? "（系列预算）" : "（广告组预算）"}
              </option>
            ))}
          </select>
        </label>
        <label className="field"><span>生成几个系列（N）</span>
          <input disabled={disabled} max={20} min={1} type="number" value={campaignCopies}
            onChange={(event) => setCampaignCopies(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} />
        </label>
        <label className="field"><span>每个系列几个广告组（M）</span>
          <input disabled={disabled} max={20} min={1} type="number" value={groupsPerCampaign}
            onChange={(event) => setGroupsPerCampaign(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} />
        </label>
        <label className="field"><span>系列日预算（留空继承源系列）</span>
          <input disabled={disabled || !sourceIsCbo} min="0.01" step="0.01" type="number" value={campaignBudgetText}
            onChange={(event) => setCampaignBudgetText(event.target.value)} />
          <small>{sourceIsCbo ? "每个新系列各自持有这一份预算。" : "源系列使用广告组预算，此处不适用。"}</small>
        </label>
        <label className="field"><span>出价（留空继承源系列）</span>
          <input disabled={disabled} min="0" step="0.01" type="number" value={bidText}
            onChange={(event) => setBidText(event.target.value)} />
        </label>
        <label className="field"><span>创建后状态</span>
          <select disabled={disabled} value={initialStatus} onChange={(event) => setInitialStatus(event.target.value as "enabled" | "disabled")}>
            <option value="disabled">关闭（默认）</option>
            <option value="enabled">立即投放</option>
          </select>
          <small>系列复制会一次拉起多个系列，默认关闭以避免误花费。</small>
        </label>
      </div>

      {sourceCampaignId && (
        <div className="campaign-copy-sources">
          <strong>源广告组（勾选参与分配，共 {adGroups.length} 个）</strong>
          {adGroups.length === 0
            ? <p className="target-account-empty">该系列在当前同步快照中没有广告组，请先执行只读同步。</p>
            : <div className="target-account-grid">
              {adGroups.map((entity) => (
                <label key={entity.externalId}>
                  <input checked={selectedAdGroupIds.includes(entity.externalId)} disabled={disabled}
                    onChange={() => toggleAdGroup(entity.externalId)} type="checkbox" />
                  <span>{entity.name}</span>
                  <small>{entity.status === "enabled" ? "投放中" : "已关闭"}</small>
                </label>
              ))}
            </div>}
        </div>
      )}

      {previewError && <div className="sheet-issues warning"><strong>无法生成分配方案</strong><span>{previewError}</span></div>}

      {previewPlan && (
        <div className="campaign-copy-preview">
          <strong>分配预览 · {previewPlan.campaigns.length} 个系列 / 共 {previewPlan.totalGroups} 个广告组</strong>
          <div className="table-wrap">
            <table>
              <thead><tr><th>新推广系列</th><th>包含的广告组</th></tr></thead>
              <tbody>
                {previewPlan.campaigns.map((campaign) => (
                  <tr key={campaign.campaignName}>
                    <td>{campaign.campaignName}</td>
                    <td>{campaign.groups.map((group) => (
                      <small key={group.name}>
                        {group.name}
                        <em>（源：{adGroups.find((entity) => entity.externalId === group.sourceAdGroupId)?.name ?? group.sourceAdGroupId}）</em>
                      </small>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {feedback && <div className="preset-save-feedback"><strong>执行结果</strong><span>{feedback}</span></div>}

      <div className="form-actions">
        <button className="primary-button" disabled={disabled || !previewPlan} onClick={() => void submit()} type="button">
          {submitting ? "正在复制…" : `确认并复制${previewPlan ? `（${previewPlan.campaigns.length} 个系列）` : ""}`}
        </button>
      </div>
    </div>
  );
}
