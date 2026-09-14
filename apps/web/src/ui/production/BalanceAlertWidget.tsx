import { useEffect, useRef, useState } from "react";
import { Wallet as WalletIcon } from "@phosphor-icons/react";

/**
 * 顶栏的余额告警浮窗。
 *
 * 收纳所有处于「跌破告警阈值」状态的账户（状态由服务端告警引擎维护，与群消息
 * 告警同一状态机）。收起来是一枚胶囊，展开后每行一个账户：名称 + 余额 + 请充值。
 *
 * 数量为 0 时不渲染任何东西——每一天大多数账户都在阈值之上，顶栏要安静。
 */
export function BalanceAlertWidget({ accounts }: {
  accounts: Array<{
    id: string;
    displayName: string;
    totalAmount: string | null;
    currency: string;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (accounts.length === 0) return null;
  return (
    <div className="p-balance-alert-area" ref={rootRef}>
      <button
        type="button"
        className="p-balance-alert-trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="这些账户可用余额已低于告警阈值"
      >
        <WalletIcon size={14} />
        <span>余额告警</span>
        <strong>{accounts.length}</strong>
      </button>
      {open && (
        <div className="p-balance-alert-panel" role="dialog" aria-label="余额告警账户">
          <div className="p-balance-alert-heading">
            <span>余额不足，请尽快充值</span>
            <button aria-label="关闭余额告警" onClick={() => setOpen(false)} type="button">✕</button>
          </div>
          <ul>
            {accounts.map((account) => (
              <li key={account.id}>
                <strong>{account.displayName}</strong>
                <span className="p-balance-alert-amount">
                  余额：{account.totalAmount === null ? "—" : account.totalAmount}
                  {account.totalAmount !== null && account.currency ? ` ${account.currency}` : ""}
                </span>
                {/* 客户端主进程把 http(s) 的窗口打开行为转交 shell.openExternal——
                    点击后由默认浏览器打开充值页。 */}
                <a
                  className="p-balance-alert-recharge"
                  href="https://yinocloud.yinolink.com/homepage"
                  target="_blank"
                  rel="noreferrer noopener"
                >请充值</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
