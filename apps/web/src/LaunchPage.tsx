import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Pencil, Rocket, Trash2, Upload, X } from "lucide-react";
import { defaultCreationPresetConfig, getCreationTemplateReadiness, type AccountConfig, type LaunchPresetInput, type LaunchPresetRecord, type LaunchSheetImportResult, type MultiAccountLaunchPlanRecord, type ProviderConnection } from "@tk-auto/core";
import { api } from "./api";
import { downloadLaunchTemplate, readLaunchSpreadsheet } from "./launch-sheet";

type LaunchMode = "single" | "multi";

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

export function LaunchPage({ accounts, onError }: { accounts: AccountConfig[]; onError: (message: string | null) => void }) {
  const [launchMode, setLaunchMode] = useState<LaunchMode>("single");
  const [sourceAccountId, setSourceAccountId] = useState(accounts[0]?.id ?? "");
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [presets, setPresets] = useState<LaunchPresetRecord[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetForm, setPresetForm] = useState<LaunchPresetInput>(freshPreset);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [plans, setPlans] = useState<MultiAccountLaunchPlanRecord[]>([]);
  const [connections, setConnections] = useState<Record<string, ProviderConnection | null>>({});
  const [sheet, setSheet] = useState<LaunchSheetImportResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedPreset = presets.find((item) => item.id === presetId) ?? null;
  const targets = useMemo(() => accounts, [accounts]);
  const selectedAccountIds = launchMode === "single" ? (sourceAccountId ? [sourceAccountId] : []) : targetIds;
  const notReadyAccountIds = selectedAccountIds.filter((accountId) => connections[accountId]?.status !== "ready");
  const templateReadiness = selectedPreset ? getCreationTemplateReadiness(selectedPreset.creationConfig) : null;
  const canSave = Boolean(selectedAccountIds.length > 0 && notReadyAccountIds.length === 0 && templateReadiness?.ready && presetId && sheet && sheet.errors.length === 0 && sheet.rows.length > 0);

  const load = async () => {
    const [nextPresets, nextPlans, connectionLists] = await Promise.all([
      api.getLaunchPresets(),
      api.getLaunchPlans(),
      Promise.all(accounts.map(async (account) => [account.id, (await api.getConnections(account.id)).find((item) => item.kind === account.providerKind) ?? null] as const)),
    ]);
    setPresets(nextPresets);
    setPlans(nextPlans);
    setConnections(Object.fromEntries(connectionLists));
    setPresetId((current) => current && nextPresets.some((item) => item.id === current) ? current : (nextPresets[0]?.id ?? ""));
  };
  useEffect(() => { void load().catch((cause) => onError(messageOf(cause))); }, [onError]);
  useEffect(() => { if (!sourceAccountId && accounts[0]) setSourceAccountId(accounts[0].id); }, [accounts, sourceAccountId]);
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
    try {
      setBusy(true);
      if (editingPresetId) await api.updateLaunchPreset(editingPresetId, presetForm);
      else await api.createLaunchPreset(presetForm);
      setPresetForm(freshPreset());
      setEditingPresetId(null);
      await load();
      onError(null);
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const editPreset = (preset: LaunchPresetRecord) => {
    setEditingPresetId(preset.id);
    setPresetForm({ name: preset.name, region: preset.region, dailyBudget: preset.dailyBudget, bid: preset.bid, startAt: preset.startAt, endAt: preset.endAt, initialStatus: preset.initialStatus, creationConfig: preset.creationConfig });
  };
  const removePreset = async (id: string) => {
    try { setBusy(true); await api.deleteLaunchPreset(id); await load(); onError(null); }
    catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const savePlan = async () => {
    if (!sheet || !canSave) return;
    let executionError: string | null = null;
    try {
      setBusy(true);
      const plan = await api.createLaunchPlan({
        mode: launchMode,
        sourceAccountId: selectedAccountIds[0] ?? sourceAccountId,
        sourceAdId: null,
        targetAccountIds: selectedAccountIds,
        launchPresetId: presetId,
        launchRows: sheet.rows,
      });
      const execution = await api.executeLaunchPlan(plan.id);
      const failed = execution.results.filter((item) => !item.ok);
      if (failed.length > 0) {
        executionError = failed.map((item) => item.message ?? "创建失败。").join("；");
      }
      setSheet(null); setFileName(""); setTargetIds([]);
      if (fileInput.current) fileInput.current.value = "";
      await load(); onError(executionError);
    } catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const cancelPlan = async (planId: string) => {
    try { setBusy(true); await api.cancelLaunchPlan(planId); await load(); onError(null); }
    catch (cause) { onError(messageOf(cause)); }
    finally { setBusy(false); }
  };

  return <section className="page-stack">
    <div className="panel launch-hero"><span><Rocket size={28} /></span><div><span className="eyebrow">多账户投放</span><h2>预设统一配置，表格只填系列、广告组、视频和产品 URL</h2><p>预算、出价、地区与创建时间等由广告预设统一管理；广告名称自动按 YYMMDD:XXX 编号。</p></div><span className="status active">创建引擎已接入</span></div>

    <div className="panel launch-mode-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>选择创建方式</h2><p>先选业务目标，系统只展示当前操作所需的信息。</p></div></div></div><div className="launch-mode-options">{([['single','单账户批量创建','向一个账户批量创建广告'],['multi','多账户同时发布','同一视频代码由各账户的素材库分别解析']] as const).map(([mode,title,description]) => <button className={launchMode === mode ? 'active' : ''} key={mode} onClick={() => { setLaunchMode(mode); if (mode === 'single') setTargetIds([]); }} type="button"><strong>{title}</strong><span>{description}</span></button>)}</div></div>

    <div className="panel launch-scope-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>发布账户</h2><p>{launchMode === "single" ? "选择一个账户，本批表格将在该账户中从零创建。" : "选择多个账户，系统将在每个账户中分别新建相同结构的广告。"}</p></div></div></div><div className="form-grid">
      {launchMode === "single" && <label className="field"><span>创建账户</span><select value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}><option value="">请选择</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}{connections[account.id]?.status === "ready" ? " · 已接入" : " · 未接入"}</option>)}</select><small>{sourceAccountId && (connections[sourceAccountId]?.status === "ready" ? "账户已接入，可执行创建。" : "该账户尚未完成两条 cURL 接入，不能创建。")}</small></label>}
      {launchMode === "multi" && <label className="field wide"><span>发布账户（可多选）</span><div className="target-account-grid">{targets.map((account) => <label key={account.id}><input checked={targetIds.includes(account.id)} onChange={(event) => setTargetIds((current) => event.target.checked ? [...new Set([...current, account.id])] : current.filter((id) => id !== account.id))} type="checkbox" /><span>{account.displayName}</span><small>{connections[account.id]?.status === "ready" ? "已接入" : "未接入"} · {account.providerKind === "cookie" ? "Cookie" : "Marketing API"}</small></label>)}</div>{notReadyAccountIds.length > 0 && <small className="field-error">已选账户中有 {notReadyAccountIds.length} 个尚未接入，完成两条 cURL 导入后才可发布。</small>}</label>}
    </div></div>

    <div className="panel launch-readiness-panel"><div className="panel-heading"><div><span className="panel-icon"><CheckCircle2 size={18} /></span><div><h2>创建检查</h2><p>只检查本次发布需要的账户、预设和导入信息；满足后点击发布即执行。</p></div></div><span className="status active">创建引擎已接入</span></div><div className="sheet-rule-grid">
      <article><strong>账户接入</strong><span>{selectedAccountIds.length === 0 ? "请选择要发布的账户。" : notReadyAccountIds.length === 0 ? `已选 ${selectedAccountIds.length} 个账户均已接入。` : `有 ${notReadyAccountIds.length} 个已选账户尚未接入。`}</span></article>
      <article><strong>视频素材</strong><span>同一视频代码由每个目标账户在自己的素材库中分别引用；不迁移素材 ID。</span></article>
      <article><strong>广告预设</strong><span>{selectedPreset ? `当前使用“${selectedPreset.name}”` : "请选择广告预设。"}</span></article>
      <article><strong>创建模板</strong><span>{!templateReadiness ? "请选择广告预设后检查模板。" : templateReadiness.ready ? "已配置，可按当前预设创建。" : "未配置：请从该账户的真实创建样本生成模板；无需填写任何内部代码。"}</span></article>
      <article><strong>导入信息</strong><span>{sheet?.errors.length === 0 && sheet.rows.length ? `已校验 ${sheet.rows.length} 条创建信息。` : "导入表只需填写系列名称、广告组名称、视频代码和产品 URL。"}</span></article>
    </div></div>

    <div className="panel"><div className="panel-heading"><div><span className="panel-icon"><Pencil size={18} /></span><div><h2>广告预设模板</h2><p>预算、出价、创建时间、结束时间和初始状态在此统一设置；保存后可复用。</p></div></div></div><div className="form-grid">
      <label className="field"><span>预设名称</span><input value={presetForm.name} onChange={(event) => setPresetForm((value) => ({ ...value, name: event.target.value }))} /></label>
      <label className="field"><span>投放地区</span><input placeholder="例如：US、美国、US/CA" value={presetForm.region} onChange={(event) => setPresetForm((value) => ({ ...value, region: event.target.value }))} /></label>
      <label className="field"><span>广告组日预算</span><input min="0.01" step="0.01" type="number" value={presetForm.dailyBudget} onChange={(event) => setPresetForm((value) => ({ ...value, dailyBudget: Number(event.target.value) }))} /></label>
      <label className="field"><span>出价（留空为自动）</span><input min="0" step="0.01" type="number" value={presetForm.bid ?? ""} onChange={(event) => setPresetForm((value) => ({ ...value, bid: event.target.value === "" ? null : Number(event.target.value) }))} /></label>
      <label className="field"><span>创建时间（留空为立即）</span><input type="datetime-local" value={toLocalInput(presetForm.startAt)} onChange={(event) => setPresetForm((value) => ({ ...value, startAt: toIso(event.target.value) }))} /><span className="quick-time-actions"><button onClick={() => setPresetForm((value) => ({ ...value, startAt: scheduledStartAt("tonight") }))} type="button">当天 24:00</button><button onClick={() => setPresetForm((value) => ({ ...value, startAt: scheduledStartAt("tomorrow-morning") }))} type="button">次日 06:00</button></span></label>
      <label className="field"><span>结束时间（可留空）</span><input type="datetime-local" value={toLocalInput(presetForm.endAt)} onChange={(event) => setPresetForm((value) => ({ ...value, endAt: toIso(event.target.value) }))} /></label>
      <label className="field"><span>初始状态</span><select value={presetForm.initialStatus} onChange={(event) => setPresetForm((value) => ({ ...value, initialStatus: event.target.value as LaunchPresetInput["initialStatus"] }))}><option value="disabled">关闭</option><option value="enabled">开启</option></select></label>
    </div><div className="creation-template-note"><strong>创建模板</strong><span>内部创建参数由系统从该账户的真实创建样本生成并加密保存。无需填写代码；模板未配置时，发布按钮会保持不可用。</span></div><div className="form-actions"><button className="primary-button" disabled={busy} onClick={() => void savePreset()} type="button">{editingPresetId ? "更新预设" : "新建预设"}</button>{editingPresetId && <button className="secondary-button" onClick={() => { setEditingPresetId(null); setPresetForm(freshPreset()); }} type="button">取消编辑</button>}</div>
      <div className="table-wrap"><table><thead><tr><th>预设</th><th>地区</th><th>预算</th><th>出价</th><th>创建时间</th><th>初始状态</th><th>操作</th></tr></thead><tbody>{presets.map((preset) => <tr key={preset.id}><td>{preset.name}</td><td>{preset.region}</td><td>{preset.dailyBudget}</td><td>{preset.bid ?? "自动"}</td><td>{preset.startAt ? new Date(preset.startAt).toLocaleString() : "立即"}</td><td>{preset.initialStatus === "enabled" ? "开启" : "关闭"}</td><td><button disabled={busy} onClick={() => editPreset(preset)} type="button">编辑</button> <button disabled={busy} onClick={() => void removePreset(preset.id)} type="button">删除</button></td></tr>)}</tbody></table></div>
    </div>

    <div className="panel launch-sheet-panel"><div className="panel-heading"><div><span className="panel-icon"><FileSpreadsheet size={18} /></span><div><h2>导入创建信息</h2><p>表格仅保留推广系列名称、广告组名称、视频代码和产品 URL。广告名称自动生成。</p></div></div><button className="secondary-button" onClick={() => void downloadLaunchTemplate().catch((cause) => onError(messageOf(cause)))} type="button"><Download size={16} /> 下载模板</button></div>
      <div className="sheet-rule-grid"><article><strong>1. 选择广告预设</strong><span>{selectedPreset ? `当前：${selectedPreset.name} · ${selectedPreset.region}（预算 ${selectedPreset.dailyBudget}）` : "请先选择预设。"}</span></article><article><strong>2. 表格只填四列</strong><span>推广系列名称、广告组名称、视频代码、产品 URL。</span></article><article><strong>3. 自动命名</strong><span>广告名称使用 YYMMDD:XXX，例如 260716:001。</span></article></div>
      <label className="field" style={{ margin: "0 18px 12px" }}><span>本次使用的广告预设</span><select value={presetId} onChange={(event) => { setPresetId(event.target.value); setSheet(null); }}><option value="">请选择预设</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
      <button className="sheet-dropzone" disabled={busy || !selectedPreset} onClick={() => fileInput.current?.click()} type="button"><Upload size={22} /><strong>{fileName || "选择 .xlsx / .csv 文件"}</strong><span>{selectedPreset ? "导入不会立即创建广告。" : "请先选择广告预设。"}</span></button><input ref={fileInput} accept=".xlsx,.csv" hidden onChange={(event) => void importFile(event.target.files?.[0])} type="file" />
      {sheet && <div className="sheet-result"><div className="sheet-summary"><span className={sheet.errors.length === 0 ? "status active" : "status danger"}>{sheet.errors.length === 0 ? <CheckCircle2 size={14} /> : <X size={14} />}{sheet.errors.length === 0 ? `校验通过：${sheet.rows.length} 条` : `${sheet.errors.length} 个错误`}</span></div>{sheet.errors.length > 0 && <IssueList issues={sheet.errors} />}{sheet.rows.length > 0 && <div className="table-wrap"><table className="sheet-preview-table"><thead><tr><th>行</th><th>推广系列</th><th>广告组</th><th>视频代码</th><th>产品 URL</th><th>广告名称</th><th>预算</th><th>出价</th></tr></thead><tbody>{sheet.rows.slice(0, 100).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.campaignName}</td><td>{row.adGroupName}</td><td>{row.videoCode}</td><td><small>{row.productUrl}</small></td><td>{row.adName}</td><td>{row.dailyBudget}</td><td>{row.bid ?? "自动"}</td></tr>)}</tbody></table></div>}</div>}
      <div className="form-actions"><button className="primary-button" disabled={busy || !canSave} onClick={() => void savePlan()} type="button">{launchMode === "single" ? "创建并发布" : "向所选账户发布"}{sheet?.rows.length ? `（${sheet.rows.length} 条 × ${selectedAccountIds.length} 个账户）` : ""}</button></div>
    </div>

    <div className="panel table-panel"><div className="panel-heading"><div><span className="panel-icon"><Rocket size={18} /></span><div><h2>投放计划</h2><p>提交后会显示真实执行结果；失败计划可修正预设后重新创建。</p></div></div></div><div className="table-wrap"><table><thead><tr><th>创建内容</th><th>预设</th><th>任务</th><th>目标账户</th><th>状态</th><th>操作</th></tr></thead><tbody>{plans.length === 0 ? <tr><td colSpan={6}>暂无投放计划。</td></tr> : plans.map((plan) => { const succeeded = plan.executionResults.filter((item) => item.ok).length; const failed = plan.executionResults.filter((item) => !item.ok).length; return <tr key={plan.id}><td>{plan.sourceAdName}</td><td>{plan.presetName}</td><td>{plan.launchRows.length}</td><td>{plan.targetAccountIds.length}{plan.executionResults.length > 0 && <small className="plan-execution-summary">成功账户 {succeeded} · 失败账户 {failed}</small>}</td><td><span className={`status ${plan.status === "completed" ? "active" : plan.status === "cancelled" ? "danger" : "warning"}`}>{plan.status === "completed" ? "已发布" : plan.status === "blocked" ? "执行失败" : plan.status}</span>{plan.executionResults.filter((item) => !item.ok).map((item) => <small className="plan-execution-error" key={item.accountId}>{item.accountId}：{item.message ?? "创建失败"}</small>)}</td><td>{["blocked", "draft"].includes(plan.status) && <button disabled={busy} onClick={() => void cancelPlan(plan.id)} type="button"><Trash2 size={14} /> 取消</button>}</td></tr>; })}</tbody></table></div></div>
  </section>;
}

function IssueList({ issues }: { issues: LaunchSheetImportResult["errors"] }) { return <div className="sheet-issues danger"><strong>需要修正</strong><ul>{issues.slice(0, 20).map((issue, index) => <li key={`${issue.rowNumber}-${issue.field}-${index}`}>第 {issue.rowNumber} 行 · {issue.field}：{issue.message}</li>)}</ul></div>; }
function toIso(value: string): string | null { return value ? new Date(value).toISOString() : null; }
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
