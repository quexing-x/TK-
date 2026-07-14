import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
  type CookieConnectionSettings,
  type AutomationAction,
  type ProviderCredentialInput,
  type SyncEntityType,
} from "@tk-auto/core";

const MAX_COMMAND_LENGTH = 262_144;

export class TikTokCurlImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokCurlImportError";
  }
}

export interface TikTokCurlImportResult {
  settings: CookieConnectionSettings;
  credential: Extract<ProviderCredentialInput, { kind: "cookie" }>;
  summary: {
    advertiserId: string;
    method: "GET" | "POST";
    path: string;
    target:
      | "health"
      | "campaign"
      | "ad-group"
      | "ad"
      | "campaign-status"
      | "ad-group-status"
      | "ad-status";
  };
}

export function parseTikTokStatusCurl(
  command: string,
): TikTokCurlImportResult {
  const imported = parseTikTokCurl(command);
  if (!imported.summary.target.endsWith("-status")) {
    throw new TikTokCurlImportError(
      "请选择在 TikTok 页面切换开关时产生的 update/status 请求。",
    );
  }
  return imported;
}

export function parseTikTokCurl(command: string): TikTokCurlImportResult {
  if (!command.trim()) {
    throw new TikTokCurlImportError("请粘贴从 Chrome 复制的 cURL 命令。");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new TikTokCurlImportError("cURL 内容过长，请重新复制单个请求。");
  }

  const tokens = tokenizeShellCommand(command);
  if (!tokens[0] || !/^curl(?:\.exe)?$/i.test(tokens[0])) {
    throw new TikTokCurlImportError("内容不是有效的 cURL 命令。");
  }

  let urlValue: string | undefined;
  let methodValue: string | undefined;
  let body: string | undefined;
  const headers = new Map<string, { name: string; value: string }>();

  const readNext = (index: number, flag: string): string => {
    const value = tokens[index + 1];
    if (value === undefined) {
      throw new TikTokCurlImportError(`${flag} 缺少内容。`);
    }
    return value;
  };

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-H" || token === "--header") {
      addHeader(headers, readNext(index, token));
      index += 1;
      continue;
    }
    if (token.startsWith("--header=")) {
      addHeader(headers, token.slice("--header=".length));
      continue;
    }
    if (token === "-b" || token === "--cookie") {
      headers.set("cookie", { name: "cookie", value: readNext(index, token) });
      index += 1;
      continue;
    }
    if (token === "-X" || token === "--request") {
      methodValue = readNext(index, token).toUpperCase();
      index += 1;
      continue;
    }
    if (token === "--url") {
      urlValue = readNext(index, token);
      index += 1;
      continue;
    }
    if (
      token === "-d" ||
      token === "--data" ||
      token === "--data-raw" ||
      token === "--data-binary"
    ) {
      body = readNext(index, token);
      index += 1;
      continue;
    }
    if (
      token.startsWith("--data=") ||
      token.startsWith("--data-raw=") ||
      token.startsWith("--data-binary=")
    ) {
      body = token.slice(token.indexOf("=") + 1);
      continue;
    }
    if (!urlValue && /^https?:\/\//i.test(token)) {
      urlValue = token;
    }
  }

  if (!urlValue) {
    throw new TikTokCurlImportError("没有在 cURL 中找到请求 URL。");
  }

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new TikTokCurlImportError("cURL 中的请求 URL 无效。");
  }
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"))
  ) {
    throw new TikTokCurlImportError("只允许导入 TikTok 官方 HTTPS 请求。");
  }

  const method = (methodValue ?? (body !== undefined ? "POST" : "GET")) as
    | "GET"
    | "POST";
  if (method !== "GET" && method !== "POST") {
    throw new TikTokCurlImportError("快速导入只支持 GET 或 POST 请求。");
  }

  const cookie = headers.get("cookie")?.value.trim();
  if (!cookie) {
    throw new TikTokCurlImportError(
      "cURL 中没有 Cookie，请确认复制的是已登录账号的请求。",
    );
  }

  const advertiserId =
    url.searchParams.get("aadvid") ??
    url.searchParams.get("advertiser_id") ??
    url.searchParams.get("advertiserId") ??
    findAdvertiserId(body);
  if (!advertiserId) {
    throw new TikTokCurlImportError(
      "请求中没有找到 Advertiser ID，请选择广告系列、广告组或广告列表请求。",
    );
  }

  const csrf = [...headers.entries()].find(([name]) =>
    ["x-csrftoken", "x-csrf-token"].includes(name),
  )?.[1];
  const target = classifyRequestTarget(url.pathname);
  const contentType = headers.get("content-type")?.value;
  const userAgent = headers.get("user-agent")?.value;
  const capturedHeaders = Object.fromEntries(
    [...headers.entries()]
      .filter(
        ([name]) =>
          ![
            "cookie",
            "content-length",
            "host",
            "user-agent",
            "connection",
            "accept-encoding",
            "transfer-encoding",
          ].includes(name) && !name.startsWith("sec-fetch-"),
      )
      .map(([name, header]) => [name, header.value]),
  );

  const settings = CookieConnectionSettingsSchema.parse({
    kind: "cookie",
    advertiserId,
    healthUrl: "",
    campaignsUrl: "",
    adGroupsUrl: "",
    adsUrl: "",
  });
  const request = {
    target,
    url: url.toString(),
    method,
    body,
    contentType,
    headers: capturedHeaders,
  } as const;
  const requestTemplates = target.endsWith("-status")
    ? createStatusTemplatePair({ ...request, target: target as StatusTarget })
    : [request];
  const credential = CookieCredentialInputSchema.parse({
    kind: "cookie",
    cookie,
    csrfToken: csrf?.value,
    csrfHeaderName: csrf?.name ?? "x-csrftoken",
    userAgent,
    requestTemplates,
  });

  return {
    settings,
    credential,
    summary: {
      advertiserId,
      method,
      path: url.pathname,
      target,
    },
  };
}

function findAdvertiserId(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return findNestedAdvertiserId(parsed);
  } catch {
    const params = new URLSearchParams(body);
    return (
      params.get("aadvid") ??
      params.get("advertiser_id") ??
      params.get("advertiserId")
    );
  }
}

function findNestedAdvertiserId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedAdvertiserId(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, item] of Object.entries(value)) {
    if (["aadvid", "advertiser_id", "advertiserId"].includes(key)) {
      if (typeof item === "string" || typeof item === "number") {
        return String(item);
      }
    }
    const found = findNestedAdvertiserId(item);
    if (found) return found;
  }
  return null;
}

function addHeader(
  headers: Map<string, { name: string; value: string }>,
  rawHeader: string,
): void {
  const separator = rawHeader.indexOf(":");
  if (separator <= 0) return;
  const name = rawHeader.slice(0, separator).trim().toLowerCase();
  const value = rawHeader.slice(separator + 1).trim();
  if (name) headers.set(name, { name, value });
}

function classifyRequestTarget(
  pathname: string,
):
  | "health"
  | "campaign"
  | "ad-group"
  | "ad"
  | "campaign-status"
  | "ad-group-status"
  | "ad-status" {
  const normalized = pathname.toLowerCase();
  const isStatus = normalized.includes("status") || normalized.includes("update");
  if (isStatus && normalized.includes("adgroup")) return "ad-group-status";
  if (isStatus && normalized.includes("campaign")) return "campaign-status";
  if (isStatus && /\/(?:ad|creative)(?:\/|_)/.test(normalized)) return "ad-status";
  if (normalized.includes("/adgroup/list")) return "ad-group";
  if (normalized.includes("/campaign/list")) return "campaign";
  if (normalized.includes("/ad/list")) return "ad";
  return "health";
}

type StatusTarget = "campaign-status" | "ad-group-status" | "ad-status";

function createStatusTemplatePair(request: {
  target: StatusTarget;
  url: string;
  method: "GET" | "POST";
  body: string | undefined;
  contentType: string | undefined;
  headers: Record<string, string>;
}) {
  const transformed = transformStatusRequest(request.url, request.body);
  return [
    {
      ...request,
      url: transformed.originalUrl,
      body: transformed.originalBody,
      action: transformed.originalAction,
    },
    {
      ...request,
      url: transformed.oppositeUrl,
      body: transformed.oppositeBody,
      action: oppositeAction(transformed.originalAction),
    },
  ];
}

function transformStatusRequest(urlValue: string, body: string | undefined): {
  originalAction: AutomationAction;
  originalUrl: string;
  oppositeUrl: string;
  originalBody: string | undefined;
  oppositeBody: string | undefined;
} {
  const url = new URL(urlValue);
  const queryResult = transformStatusParams(url.searchParams);
  let bodyResult: StatusTransformResult | null = null;
  let oppositeBody = body;

  if (body) {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(body) as unknown;
        bodyResult = transformStatusJson(parsed);
        if (bodyResult) oppositeBody = JSON.stringify(bodyResult.opposite);
      } catch {
        throw new TikTokCurlImportError(
          "状态 cURL 的 JSON 请求体无法解析，请重新复制单个请求。",
        );
      }
    } else {
      const params = new URLSearchParams(body);
      bodyResult = transformStatusParams(params);
      if (bodyResult) oppositeBody = params.toString();
    }
  }

  const action = bodyResult?.action ?? queryResult?.action;
  if (!action) {
    throw new TikTokCurlImportError(
      "无法从状态 cURL 中明确识别开启或关闭字段，未保存该请求。",
    );
  }
  if (bodyResult && queryResult && bodyResult.action !== queryResult.action) {
    throw new TikTokCurlImportError("状态 cURL 中存在互相冲突的状态字段。");
  }
  const oppositeUrl = queryResult ? url.toString() : urlValue;
  return {
    originalAction: action,
    originalUrl: urlValue,
    oppositeUrl,
    originalBody: body,
    oppositeBody,
  };
}

interface StatusTransformResult {
  action: AutomationAction;
  opposite: unknown;
}

function transformStatusParams(params: URLSearchParams): StatusTransformResult | null {
  let action: AutomationAction | null = null;
  for (const key of [...params.keys()]) {
    if (!isStatusKey(key)) continue;
    const value = params.get(key);
    const detected = detectStatusValue(value);
    if (!detected) continue;
    if (action && action !== detected.action) {
      throw new TikTokCurlImportError("状态 cURL 中存在互相冲突的状态字段。");
    }
    action = detected.action;
    params.set(key, String(detected.opposite));
  }
  return action ? { action, opposite: params } : null;
}

function transformStatusJson(value: unknown): StatusTransformResult | null {
  let action: AutomationAction | null = null;
  const visit = (item: unknown, key = ""): unknown => {
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(
        Object.entries(item).map(([childKey, child]) => [
          childKey,
          visit(child, childKey),
        ]),
      );
    }
    if (!isStatusKey(key)) return item;
    const detected = detectStatusValue(item);
    if (!detected) return item;
    if (action && action !== detected.action) {
      throw new TikTokCurlImportError("状态 cURL 中存在互相冲突的状态字段。");
    }
    action = detected.action;
    return detected.opposite;
  };
  const opposite = visit(value);
  return action ? { action, opposite } : null;
}

function isStatusKey(key: string): boolean {
  return /(?:^|_)(?:status|operation_status|opt_status)$/.test(key.toLowerCase());
}

function detectStatusValue(
  value: unknown,
): { action: AutomationAction; opposite: unknown } | null {
  if (value === 0 || value === "0" || value === false) {
    return { action: "disable", opposite: typeof value === "string" ? "1" : value === false ? true : 1 };
  }
  if (value === 1 || value === "1" || value === true) {
    return { action: "enable", opposite: typeof value === "string" ? "0" : value === true ? false : 0 };
  }
  if (typeof value !== "string") return null;
  const pairs: Array<[string, string]> = [
    ["enable", "disable"],
    ["enabled", "disabled"],
    ["on", "off"],
    ["open", "close"],
    ["active", "inactive"],
  ];
  const normalized = value.toLowerCase();
  for (const [enabled, disabled] of pairs) {
    if (normalized === enabled) {
      return { action: "enable", opposite: matchCase(value, disabled) };
    }
    if (normalized === disabled) {
      return { action: "disable", opposite: matchCase(value, enabled) };
    }
  }
  return null;
}

function matchCase(source: string, value: string): string {
  return source === source.toUpperCase() ? value.toUpperCase() : value;
}

function oppositeAction(action: AutomationAction): AutomationAction {
  return action === "enable" ? "disable" : "enable";
}

function tokenizeShellCommand(command: string): string[] {
  const input = command
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .trim();
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;

  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = null;
      else current += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else current += character;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "\\" || character === "^") {
      escaped = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    current += character;
  }

  if (quote || escaped) {
    throw new TikTokCurlImportError("cURL 命令的引号或换行不完整。");
  }
  push();
  return tokens;
}
