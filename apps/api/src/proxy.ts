import { execFileSync } from "node:child_process";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";

const INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export interface OutboundProxyConfig {
  source: "environment" | "windows-system";
  url: string;
}

export function resolveOutboundProxy(
  environment: NodeJS.ProcessEnv = process.env,
  windowsProxy = process.platform === "win32"
    ? readWindowsSystemProxy()
    : undefined,
): OutboundProxyConfig | null {
  const environmentProxy =
    environment.HTTPS_PROXY ??
    environment.https_proxy ??
    environment.HTTP_PROXY ??
    environment.http_proxy ??
    environment.ALL_PROXY ??
    environment.all_proxy;
  if (environmentProxy) {
    const url = normalizeProxyUrl(environmentProxy);
    return url ? { source: "environment", url } : null;
  }
  const url = normalizeProxyUrl(windowsProxy);
  return url ? { source: "windows-system", url } : null;
}

export function installOutboundProxy(
  config: OutboundProxyConfig | null,
): ProxyAgent | null {
  if (!config) return null;
  const agent = new ProxyAgent(config.url);
  setGlobalDispatcher(agent);
  return agent;
}

/**
 * 与 installOutboundProxy 的区别：config 为 null 时会把全局 dispatcher 显式复位成
 * 直连，而不是保留上一个代理。切换用的入口。
 */
export function applyOutboundProxy(
  config: OutboundProxyConfig | null,
): ProxyAgent | null {
  if (!config) {
    setGlobalDispatcher(new Agent());
    return null;
  }
  const agent = new ProxyAgent(config.url);
  setGlobalDispatcher(agent);
  return agent;
}

function sameProxy(
  left: OutboundProxyConfig | null,
  right: OutboundProxyConfig | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.url === right.url && left.source === right.source;
}

export interface OutboundProxyWatcher {
  stop(): void;
  current(): OutboundProxyConfig | null;
  /** 立即重新解析一次；返回本次是否发生了切换。 */
  refresh(): boolean;
}

export const outboundProxyWatchIntervalMs = 30_000;

/**
 * 持续跟随出站代理的变化。
 *
 * 出站代理原本只在进程启动时解析一次并冻结整个生命周期。后台调度器是开机自启的，
 * 常常比 VPN / 代理客户端先启动：那一刻系统代理尚未写入注册表，进程便判定「直连」
 * 并一直维持，等代理起来了也不会重新解析——表现为自动化静默失效，直到人工重启
 * 整个程序才恢复。反过来（启动时代理已配置但端口还没监听）同样会留下一个指向死
 * 端口的连接池。
 *
 * 这里改成周期性重新解析，只在解析结果真的变化时才替换全局 dispatcher，并关闭旧
 * 的连接池。
 */
export function startOutboundProxyWatcher(options: {
  intervalMs?: number;
  /** 启动时已经安装的配置；省略则立即解析一次。 */
  initial?: OutboundProxyConfig | null;
  resolve?: () => OutboundProxyConfig | null;
  apply?: (config: OutboundProxyConfig | null) => ProxyAgent | null;
  onChange?: (
    next: OutboundProxyConfig | null,
    previous: OutboundProxyConfig | null,
  ) => void;
} = {}): OutboundProxyWatcher {
  const resolve = options.resolve ?? (() => resolveOutboundProxy());
  const apply = options.apply ?? applyOutboundProxy;
  let current = options.initial !== undefined ? options.initial : resolve();
  let installed: ProxyAgent | null = null;

  const refresh = (): boolean => {
    let next: OutboundProxyConfig | null;
    try {
      next = resolve();
    } catch {
      // 解析失败（例如 reg.exe 超时）时保持现状，下一轮再试。
      return false;
    }
    if (sameProxy(next, current)) return false;
    const previous = current;
    const previousAgent = installed;
    installed = apply(next);
    current = next;
    void previousAgent?.close().catch(() => undefined);
    options.onChange?.(next, previous);
    return true;
  };

  const timer = setInterval(
    refresh,
    options.intervalMs ?? outboundProxyWatchIntervalMs,
  );
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    current: () => current,
    refresh,
  };
}

export function readWindowsSystemProxy(): string | undefined {
  try {
    const output = execFileSync("reg.exe", ["query", INTERNET_SETTINGS_KEY], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    });
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output);
    if (!enabled) return undefined;
    const server = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1];
    return selectWindowsProxy(server?.trim());
  } catch {
    return undefined;
  }
}

function selectWindowsProxy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.includes("=")) return value;
  const entries = new Map(
    value.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      return separator > 0
        ? [[part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim()] as const]
        : [];
    }),
  );
  return entries.get("https") ?? entries.get("http");
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
