import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type ToastTone = "success" | "error" | "info";
type ConfirmOptions = { title: string; message: string; confirmLabel?: string; danger?: boolean };
type PromptOptions = ConfirmOptions & { placeholder?: string; defaultValue?: string; required?: boolean };
type ActiveDialog = ({ kind: "confirm"; options: ConfirmOptions } | { kind: "prompt"; options: PromptOptions }) & { resolve: (value: unknown) => void };

type OverlayContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  toast: (message: string, tone?: ToastTone) => void;
};

const OverlayContext = createContext<OverlayContextValue | null>(null);
let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";

export function useOverlays(): OverlayContextValue {
  const value = useContext(OverlayContext);
  if (!value) throw new Error("Overlay context is unavailable.");
  return value;
}

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (bodyLockCount === 0) bodyOverflowBeforeLock = document.body.style.overflow;
    bodyLockCount += 1;
    document.body.style.overflow = "hidden";
    return () => {
      bodyLockCount = Math.max(0, bodyLockCount - 1);
      if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
    };
  }, [active]);
}

export function Modal({ children, onClose, title, eyebrow, danger = false, icon }: {
  children: ReactNode; onClose: () => void; title: string; eyebrow?: string; danger?: boolean; icon?: ReactNode;
}) {
  useBodyScrollLock(true);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="modal-backdrop unified-overlay" onMouseDown={onClose} role="presentation">
    <section aria-modal="true" className={danger ? "modal unified-modal is-danger" : "modal unified-modal"} onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <div className="modal-heading"><div className="modal-heading-main">{icon && <span className="modal-heading-icon">{icon}</span>}<div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div></div><button aria-label="关闭" type="button" onClick={onClose}><X size={20} /></button></div>
      {children}
    </section>
  </div>;
}

export function CommandPalette({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useBodyScrollLock(true);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <><div aria-hidden="true" className="command-palette-backdrop" onMouseDown={onClose} /><section aria-label="全局命令" className="command-menu command-palette" role="dialog">{children}</section></>;
}

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: ToastTone }>>([]);
  const toast = useCallback((message: string, tone: ToastTone = "success") => {
    const id = Date.now() + Math.floor(Math.random() * 10_000);
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4_500);
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ kind: "confirm", options, resolve: (value) => resolve(Boolean(value)) })), []);
  const prompt = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => setDialog({ kind: "prompt", options, resolve: (value) => resolve(typeof value === "string" ? value : null) })), []);
  const value = useMemo(() => ({ confirm, prompt, toast }), [confirm, prompt, toast]);
  useEffect(() => {
    const showApiResult = (event: Event) => {
      const detail = (event as CustomEvent<{ ok: boolean; message: string }>).detail;
      if (detail) toast(detail.message, detail.ok ? "success" : "error");
    };
    window.addEventListener("tk-api-write", showApiResult);
    return () => window.removeEventListener("tk-api-write", showApiResult);
  }, [toast]);
  return <OverlayContext.Provider value={value}><LegacyModalBridge />{children}
    <div aria-live="polite" className="toast-stack">{toasts.map((item) => <div className={`app-toast ${item.tone}`} key={item.id}>{item.tone === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span>{item.message}</span><button aria-label="关闭提示" onClick={() => setToasts((current) => current.filter((toastItem) => toastItem.id !== item.id))} type="button"><X size={15} /></button></div>)}</div>
    {dialog && <Dialog dialog={dialog} onClose={() => { dialog.resolve(dialog.kind === "confirm" ? false : null); setDialog(null); }} onConfirm={(value) => { dialog.resolve(value); setDialog(null); }} />}
  </OverlayContext.Provider>;
}

function LegacyModalBridge() {
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    const refresh = () => setModalOpen(Boolean(document.querySelector(".modal-backdrop")));
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useBodyScrollLock(modalOpen);
  useEffect(() => {
    const closeLegacyModal = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !document.querySelector(".modal-backdrop")) return;
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-backdrop .modal-heading button"));
      buttons.at(-1)?.click();
    };
    window.addEventListener("keydown", closeLegacyModal);
    return () => window.removeEventListener("keydown", closeLegacyModal);
  }, []);
  return null;
}

function Dialog({ dialog, onClose, onConfirm }: { dialog: ActiveDialog; onClose: () => void; onConfirm: (value: boolean | string) => void }) {
  const [value, setValue] = useState(dialog.kind === "prompt" ? dialog.options.defaultValue ?? "" : "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const options = dialog.options as PromptOptions;
  const valid = dialog.kind !== "prompt" || !options.required || value.trim().length > 0;
  return <Modal danger={Boolean(options.danger)} eyebrow={options.danger ? "需要确认" : "操作确认"} icon={options.danger ? <AlertTriangle size={19} /> : <Info size={19} />} onClose={onClose} title={options.title}>
    <div className="dialog-body"><p>{options.message}</p>{dialog.kind === "prompt" && <input ref={inputRef} placeholder={options.placeholder} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && valid) onConfirm(value.trim()); }} />}</div>
    <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className={options.danger ? "danger-button" : "primary-button"} disabled={!valid} type="button" onClick={() => onConfirm(dialog.kind === "prompt" ? value.trim() : true)}>{options.confirmLabel ?? "确认"}</button></div>
  </Modal>;
}
