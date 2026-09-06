import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { CaretLeft, CaretRight, Check, Circle, SpinnerGap, X } from "@phosphor-icons/react";
import { useBodyScrollLock } from "../overlays";
import "./production.css";

export function Button({ children, tone = "default", busy = false, className = "", disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger" | "quiet"; busy?: boolean }) {
  return <button type="button" {...props} disabled={disabled || busy} aria-busy={busy || undefined} className={`p-button p-button-${tone} ${className}`}>{busy && <SpinnerGap className="p-spin" size={16} />}{children}</button>;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "healthy" | "warning" | "danger" }) {
  return <span className={`p-badge p-badge-${tone}`}><i aria-hidden="true" />{children}</span>;
}
export function Checkbox({ mixed = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input {...props} ref={ref} type="checkbox" className="p-checkbox" />;
}
export function Drawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useBodyScrollLock(true);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); requestAnimationFrame(() => { if (previous?.isConnected) previous.focus(); }); };
  }, []);
  return <dialog ref={ref} className="p-drawer" aria-labelledby={titleId} onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }}>
    <header className="p-drawer-header"><h2 id={titleId}>{title}</h2><Button tone="quiet" aria-label="关闭账户详情" onClick={onClose}><X size={20} /></Button></header>
    <div className="p-drawer-body">{children}</div>
  </dialog>;
}
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="p-empty">{icon}<strong>{title}</strong>{children && <div>{children}</div>}</div>;
}
export function Pagination({ page, total, size, onPage, onSize }: { page: number; total: number; size: number; onPage: (page: number) => void; onSize: (size: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <footer className="p-pagination"><span>共 {total} 个账户{total > 0 && ` · 显示 ${(page - 1) * size + 1}–${Math.min(total, page * size)}`}</span><div><label>每页 <select aria-label="每页账户数" value={size} onChange={(e) => onSize(Number(e.target.value))}>{[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><Button aria-label="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><CaretLeft size={16} /></Button><span className="p-number">{page} / {pages}</span><Button aria-label="下一页" disabled={page >= pages} onClick={() => onPage(page + 1)}><CaretRight size={16} /></Button></div></footer>;
}
export type ControlRailStep = {
  label: string;
  ready: boolean;
  detail: string;
  failureReason?: string | undefined;
  lastFailureAt?: string | undefined;
  recovery?: { label: string; onClick: () => void; busy?: boolean | undefined; disabled?: boolean | undefined } | undefined;
};
function railTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
export function ControlRail({ steps }: { steps: ControlRailStep[] }) {
  return <ol className="p-rail">{steps.map((step) => {
    const diagnostic = !step.ready && Boolean(step.failureReason || step.lastFailureAt || step.recovery);
    return <li key={step.label} className={step.ready ? "is-ready" : diagnostic ? "is-failed" : ""}>
      <span className="p-rail-node">{step.ready ? <Check size={14} /> : <Circle size={10} />}</span>
      <div className="p-rail-main"><div className="p-rail-summary"><div><strong>{step.label}</strong><small>{step.detail}</small></div><Badge tone={step.ready ? "healthy" : diagnostic ? "danger" : "neutral"}>{step.ready ? "已就绪" : diagnostic ? "需处理" : "未就绪"}</Badge></div>
        {diagnostic && <details className="p-rail-diagnostic" open><summary>查看原因与恢复</summary><div className="p-rail-diagnostic-body">{step.failureReason && <p><strong>原因</strong>{step.failureReason}</p>}{step.lastFailureAt && <p><strong>最近失败</strong><time dateTime={step.lastFailureAt}>{railTimestamp(step.lastFailureAt)}</time></p>}{step.recovery && <Button tone="quiet" busy={step.recovery.busy ?? false} disabled={step.recovery.disabled ?? false} onClick={step.recovery.onClick}>{step.recovery.label}</Button>}</div></details>}
      </div>
    </li>;
  })}</ol>;
}
