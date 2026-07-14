import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CopyPlus,
  Download,
  FileSpreadsheet,
  RefreshCcw,
  Rocket,
  Upload,
  X,
} from "lucide-react";
import type {
  AccountConfig,
  LaunchSheetImportResult,
  ManagedEntityRecord,
  MultiAccountLaunchPlanRecord,
} from "@tk-auto/core";
import { api } from "./api";
import { downloadLaunchTemplate, readLaunchSpreadsheet } from "./launch-sheet";

type ImportMode = "spreadsheet" | "single";

export function LaunchPage({ accounts, onError }: { accounts: AccountConfig[]; onError: (message: string | null) => void }) {
  const [mode, setMode] = useState<ImportMode>("spreadsheet");
  const [sourceAccountId, setSourceAccountId] = useState(accounts[0]?.id ?? "");
  const [sourceAdId, setSourceAdId] = useState("");
  const [ads, setAds] = useState<ManagedEntityRecord[]>([]);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [namingTemplate, setNamingTemplate] = useState("{source_name}-{account_name}-{date}");
  const [startPaused, setStartPaused] = useState(true);
  const [plans, setPlans] = useState<MultiAccountLaunchPlanRecord[]>([]);
  const [sheet, setSheet] = useState<LaunchSheetImportResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadPlans = async () => setPlans(await api.getLaunchPlans());
  useEffect(() => void loadPlans().catch((cause) => onError(messageOf(cause))), [onError]);
  useEffect(() => {
    if (!sourceAccountId && accounts[0]) setSourceAccountId(accounts[0].id);
  }, [accounts, sourceAccountId]);
  useEffect(() => {
    setSourceAdId("");
    if (!sourceAccountId) return;
    void api.getManagedEntities(sourceAccountId)
      .then((items) => setAds(items.filter((item) => item.entityType === "ad")))
      .catch((cause) => onError(messageOf(cause)));
  }, [onError, sourceAccountId]);

  const targets = useMemo(() => accounts.filter((account) => account.id !== sourceAccountId), [accounts, sourceAccountId]);
  const canSaveSheet = Boolean(sourceAdId && targetIds.length > 0 && sheet && sheet.rows.length > 0 && sheet.errors.length === 0);

  const createSingle = async (event: FormEvent) => {
    event.preventDefault();
    await createPlan({ namingTemplate, startPaused });
  };

  const createSheetPlan = async () => {
    if (!sheet || !canSaveSheet) return;
    await createPlan({
      namingTemplate: "表格内名称",
      startPaused: sheet.rows.every((row) => row.initialStatus === "disabled"),
      launchRows: sheet.rows,
    });
  };

  const createPlan = async (options: { namingTemplate: string; startPaused: boolean; launchRows?: NonNullable<MultiAccountLaunchPlanRecord["launchRows"]> }) => {
    try {
      setBusy(true);
      await api.createLaunchPlan({
        sourceAccountId,
        sourceAdId,
        targetAccountIds: targetIds,
        namingTemplate: options.namingTemplate,
        startPaused: options.startPaused,
        ...(options.launchRows ? { launchRows: options.launchRows } : {}),
      });
      setTargetIds([]);
      if (options.launchRows) {
        setSheet(null);
        setFileName("");
        if (fileInput.current) fileInput.current.value = "";
      }
      await loadPlans();
      onError(null);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setBusy(true);
      const result = await readLaunchSpreadsheet(file);
      setSheet(result);
      setFileName(file.name);
      onError(result.errors.length > 0 ? `表格存在 ${result.errors.length} 个错误，请按行修正后重新导入。` : null);
    } catch (cause) {
      setSheet(null);
      setFileName(file.name);
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelPlan = async (planId: string) => {
    try {
      setBusy(true);
      await api.cancelLaunchPlan(planId);
      await loadPlans();
      onError(null);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return <section className="page-stack">
    <div className="panel launch-hero"><span><Rocket size={28} /></span><div><span className="eyebrow">多账户投放</span><h2>一份配置，批量分发到多个账户</h2><p>源广告和目标账户只选择一次；表格只填写系列、预算、出价和时间等变化项。</p></div><span className="status warning">真实创建接口待接入</span></div>

    <div className="panel launch-scope-panel">
      <div className="panel-heading"><div><span className="panel-icon"><CopyPlus size={18} /></span><div><h2>投放范围</h2><p>本次选择应用到表格内全部任务，避免在每一行重复填写账户。</p></div></div></div>
      <div className="form-grid">
        <label className="field"><span>源广告账户</span><select required value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}><option value="">请选择</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
        <label className="field"><span>源广告</span><select required value={sourceAdId} onChange={(event) => setSourceAdId(event.target.value)}><option value="">请选择已同步广告</option>{ads.map((ad) => <option key={ad.externalId} value={ad.externalId}>{ad.name}</option>)}</select><small>{ads.length === 0 ? "暂无广告，请先在自动化中心检测源账户。" : `已读取 ${ads.length} 条真实广告。`}</small></label>
        <label className="field wide"><span>目标账户（可多选）</span><div className="target-account-grid">{targets.length === 0 ? <p className="inline-empty">请至少接入两个广告账户。</p> : targets.map((account) => <label key={account.id}><input checked={targetIds.includes(account.id)} onChange={(event) => setTargetIds((current) => event.target.checked ? [...new Set([...current, account.id])] : current.filter((id) => id !== account.id))} type="checkbox" /><span>{account.displayName}</span><small>{account.providerKind === "cookie" ? "Cookie" : "Marketing API"}</small></label>)}</div></label>
      </div>
    </div>

    <div className="launch-mode-tabs" role="tablist">
      <button className={mode === "spreadsheet" ? "active" : ""} onClick={() => setMode("spreadsheet")} type="button"><FileSpreadsheet size={17} /> 表格批量导入</button>
      <button className={mode === "single" ? "active" : ""} onClick={() => setMode("single")} type="button"><CopyPlus size={17} /> 单条快速创建</button>
    </div>

    {mode === "spreadsheet" ? <div className="panel launch-sheet-panel">
      <div className="panel-heading"><div><span className="panel-icon"><FileSpreadsheet size={18} /></span><div><h2>导入创建信息</h2><p>支持 .xlsx 和 .csv；单次最多 500 条，空白单元格自动继承上一行。</p></div></div><button className="secondary-button" onClick={() => void downloadLaunchTemplate().catch((cause) => onError(messageOf(cause)))} type="button"><Download size={16} /> 下载模板与填写规范</button></div>
      <div className="sheet-rule-grid">
        <article><strong>1. 软件内选一次</strong><span>源广告与全部目标账户无需写入表格。</span></article>
        <article><strong>2. 只填变化项</strong><span>系列、名称、预算、出价、时间、状态的空白格继承上一行。</span></article>
        <article><strong>3. 先校验再保存</strong><span>错误精确到行和字段；通过后才保存为本地投放计划。</span></article>
      </div>
      <button className="sheet-dropzone" disabled={busy} onClick={() => fileInput.current?.click()} type="button"><Upload size={22} /><strong>{fileName || "选择 .xlsx / .csv 文件"}</strong><span>{busy ? "正在解析…" : "点击选择文件；导入不会立即创建广告"}</span></button>
      <input ref={fileInput} accept=".xlsx,.csv" hidden onChange={(event) => void importFile(event.target.files?.[0])} type="file" />

      {sheet && <div className="sheet-result">
        <div className="sheet-summary">
          <span className={sheet.errors.length === 0 ? "status active" : "status danger"}>{sheet.errors.length === 0 ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {sheet.errors.length === 0 ? `校验通过：${sheet.rows.length} 条` : `${sheet.errors.length} 个错误`}</span>
          {sheet.warnings.length > 0 && <span className="status warning">{sheet.warnings.length} 条自动补全提醒</span>}
        </div>
        {sheet.errors.length > 0 && <IssueList title="需要修正" issues={sheet.errors} tone="danger" />}
        {sheet.warnings.length > 0 && <IssueList title="自动补全" issues={sheet.warnings} tone="warning" />}
        {sheet.rows.length > 0 && <div className="table-wrap"><table className="sheet-preview-table"><thead><tr><th>行</th><th>任务</th><th>推广系列</th><th>广告组 / 广告</th><th>日预算</th><th>出价</th><th>创建时间</th><th>初始状态</th></tr></thead><tbody>{sheet.rows.slice(0, 100).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.taskName}</td><td>{row.campaignName}</td><td>{row.adGroupName}<br /><small>{row.adName}</small></td><td>{row.dailyBudget}</td><td>{row.bid ?? "自动"}</td><td>{row.startAt ? new Date(row.startAt).toLocaleString() : "立即"}</td><td>{row.initialStatus === "enabled" ? "开启" : "关闭"}</td></tr>)}</tbody></table>{sheet.rows.length > 100 && <p className="retention-note">仅预览前 100 条，全部 {sheet.rows.length} 条都会保存。</p>}</div>}
      </div>}
      <div className="form-actions"><button className="primary-button" disabled={busy || !canSaveSheet} onClick={() => void createSheetPlan()} type="button">保存批量投放计划{sheet?.rows.length ? `（${sheet.rows.length} 条 × ${targetIds.length} 个账户）` : ""}</button></div>
    </div> : <form className="panel" onSubmit={(event) => void createSingle(event)}>
      <div className="panel-heading"><div><span className="panel-icon"><CopyPlus size={18} /></span><div><h2>单条快速创建</h2><p>保留原有快速规划方式，适合只复制一个广告。</p></div></div></div>
      <div className="form-grid"><label className="field"><span>命名规则</span><input required value={namingTemplate} onChange={(event) => setNamingTemplate(event.target.value)} /><small>支持 source_name、account_name、date 占位符。</small></label><label className="check-row"><input checked={startPaused} onChange={(event) => setStartPaused(event.target.checked)} type="checkbox" /> 新建广告默认关闭（推荐）</label></div>
      <div className="form-actions"><button className="primary-button" disabled={busy || !sourceAdId || targetIds.length === 0} type="submit">保存单条投放计划</button></div>
    </form>}

    <div className="panel table-panel"><div className="panel-heading"><div><span className="panel-icon"><RefreshCcw size={18} /></span><div><h2>投放计划</h2><p>“等待接口”表示配置已安全保存，尚未对 TikTok 执行外部写入。</p></div></div></div><div className="table-wrap"><table><thead><tr><th>源广告</th><th>任务</th><th>目标账户</th><th>状态</th><th>说明</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{plans.length === 0 ? <tr><td colSpan={7}>暂无投放计划。</td></tr> : plans.map((plan) => <tr key={plan.id}><td>{plan.sourceAdName}<br /><small>{plan.sourceAdId}</small></td><td>{plan.launchRows.length || 1}</td><td>{plan.targetAccountIds.length}</td><td><span className={plan.status === "cancelled" ? "status" : "status warning"}>{plan.status === "blocked" ? "等待接口" : plan.status === "cancelled" ? "已取消" : plan.status}</span></td><td>{plan.message ?? "—"}</td><td>{new Date(plan.createdAt).toLocaleString()}</td><td>{["blocked", "draft"].includes(plan.status) && <button disabled={busy} onClick={() => void cancelPlan(plan.id)} type="button"><X size={14} /> 取消</button>}</td></tr>)}</tbody></table></div></div>
  </section>;
}

function IssueList({ title, issues, tone }: { title: string; issues: LaunchSheetImportResult["errors"]; tone: "danger" | "warning" }) {
  return <div className={`sheet-issues ${tone}`}><strong>{title}</strong><ul>{issues.slice(0, 20).map((issue, index) => <li key={`${issue.rowNumber}-${issue.field}-${index}`}>第 {issue.rowNumber} 行 · {issue.field}：{issue.message}</li>)}</ul>{issues.length > 20 && <span>另有 {issues.length - 20} 条未展开。</span>}</div>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "投放计划操作失败。";
}
