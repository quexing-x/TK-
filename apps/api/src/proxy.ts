import { execFileSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";

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
