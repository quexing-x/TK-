import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
  type CookieConnectionSettings,
  type AutomationAction,
  type ProviderCredentialInput,
  type SyncEntityType,
} from "@tk-auto/core";
import {
  copyMultipartField,
  isMultipartBody,
  parseMultipartFields,
  rewriteMultipartFields,
} from "./multipart.js";

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
      | "ad-status"
      | "appeal";
  };
}

export interface TikTokCookieImportReadiness {
  dataRequestImported: boolean;
  statusRequestImported: boolean;
  requiredFields: {
    listQuery: boolean;
    updateQuery: boolean;
    copyQuery: boolean;
    csrfToken: boolean;
    cookie: boolean;
  };
  completedFields: number;
  totalFields: 5;
  fieldsComplete: boolean;
}

export function getTikTokCookieImportReadiness(
  credential?: Extract<ProviderCredentialInput, { kind: "cookie" }>,
): TikTokCookieImportReadiness {
  const templates = credential?.requestTemplates ?? [];
  const listTemplate = templates.find(
    (item) => item.target === "ad-group" && !item.derived,
  );
  const statusTemplate = templates.find(
    (item) => item.target.endsWith("-status") && !item.derived,
  );
  const controlTemplatesReady = (
    ["campaign-status", "ad-group-status", "ad-status"] as const
  ).every((target) =>
    (["enable", "disable"] as const).every((action) =>
      templates.some(
        (item) => item.target === target && item.action === action,
      ),
    ),
  );
  const hasDocumentedQuery = (
    template: (typeof templates)[number] | undefined,
  ) => {
    if (!template) return false;
    const url = new URL(template.url);
    return url.search.length > 1 && url.searchParams.has("aadvid");
  };
  const requiredFields = {
    listQuery: hasDocumentedQuery(listTemplate),
    updateQuery: hasDocumentedQuery(statusTemplate),
    copyQuery: hasDocumentedQuery(listTemplate),
    csrfToken: Boolean(credential?.csrfToken?.trim()),
    cookie: Boolean(credential?.cookie?.trim()),
  };
  const completedFields = Object.values(requiredFields).filter(Boolean).length;
  return {
    dataRequestImported: Boolean(listTemplate),
    statusRequestImported: Boolean(statusTemplate) && controlTemplatesReady,
    requiredFields,
    completedFields,
    totalFields: 5,
    fieldsComplete: completedFields === 5,
  };
}

export function parseTikTokStatusCurl(
  command: string,
): TikTokCurlImportResult {
  const imported = parseTikTokCurl(command, "status");
  validateDocumentedStatusRequest(imported);
  return imported;
}

export function parseTikTokReadCurl(
  command: string,
): TikTokCurlImportResult {
  return parseTikTokCurl(command, "read");
}

export function parseTikTokCurl(
  command: string,
  expectedKind?: "read" | "status" | "appeal",
): TikTokCurlImportResult {
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
  if (expectedKind === "read" && target !== "ad-group") {
    throw new TikTokCurlImportError(
      "第 1 段只接受 Network 中通过 /adgroup/list/? 搜索到的真实列表 cURL。",
    );
  }
  if (expectedKind === "status" && !target.endsWith("-status")) {
    throw new TikTokCurlImportError(
      "第 2 段只接受真实启停请求，请复制 /ad/update_status/? 对应的 POST cURL。",
    );
  }
  if (expectedKind === "appeal" && target !== "appeal") throw new TikTokCurlImportError("请复制 appeal_creative 的 POST cURL。");
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
    ? createAllStatusTemplatePairs({
        ...request,
        target: target as StatusTarget,
      })
    : ["campaign", "ad-group", "ad"].includes(target)
      ? createAllReadTemplates(request as ReadTemplateRequest)
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

function validateDocumentedStatusRequest(
  imported: TikTokCurlImportResult,
): void {
  const path = imported.summary.path.toLowerCase().replace(/\/+$/, "");
  if (!/\/(?:ad|creative)\/update_status$/.test(path)) {
    throw new TikTokCurlImportError(
      "第 2 段只接受 Network 中通过 /ad/update_status/? 搜索到的真实启停 cURL。",
    );
  }
  if (imported.summary.method !== "POST") {
    throw new TikTokCurlImportError("真实启停 cURL 必须使用 POST 请求。");
  }
  const template = imported.credential.requestTemplates?.find(
    (item) => item.target === imported.summary.target && !item.derived,
  );
  if (!template) {
    throw new TikTokCurlImportError(
      "启停 cURL 未生成可用请求模板，请重新复制切换广告开关时出现的请求。",
    );
  }
  const url = new URL(template.url);
  if (!url.search || !url.searchParams.has("aadvid")) {
    throw new TikTokCurlImportError(
      "启停 cURL 缺少问号后的更新查询参数或 aadvid，请复制完整请求。",
    );
  }
  if (path.endsWith("/creative/update_status")) {
    if (!template.body || !isMultipartBody(template.contentType, template.body)) {
      throw new TikTokCurlImportError(
        "最终广告启停 cURL 必须包含 multipart/form-data 请求体。",
      );
    }
    const names = new Set(
      parseMultipartFields(template.body).map((field) =>
        field.name.toLowerCase(),
      ),
    );
    const missing = ["creative_list", "aco_creative_list", "operation"].filter(
      (field) => !names.has(field),
    );
    if (missing.length > 0) {
      throw new TikTokCurlImportError(
        `最终广告启停 cURL 缺少必需字段：${missing.join("、")}。`,
      );
    }
  }
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
  | "ad-status"
  | "appeal" {
  const normalized = pathname.toLowerCase();
  if (normalized.includes("appeal_creative")) return "appeal";
  const isStatus = normalized.includes("status") || normalized.includes("update");
  if (isStatus && normalized.includes("adgroup")) return "ad-group-status";
  if (isStatus && normalized.includes("campaign")) return "campaign-status";
  if (isStatus && normalized.includes("/creative/")) return "ad-status";
  if (isStatus && /\/ad(?:\/|_)/.test(normalized)) return "ad-group-status";
  if (normalized.includes("/adgroup/list")) return "ad-group";
  if (normalized.includes("/campaign/list")) return "campaign";
  if (normalized.includes("/creative/list")) return "ad";
  if (normalized.includes("/ad/list")) return "ad";
  return "health";
}

type StatusTarget = "campaign-status" | "ad-group-status" | "ad-status";
type ReadTarget = "campaign" | "ad-group" | "ad";
type ReadTemplateRequest = {
  target: ReadTarget;
  url: string;
  method: "GET" | "POST";
  body: string | undefined;
  contentType: string | undefined;
  headers: Record<string, string>;
};

function createAllReadTemplates(request: ReadTemplateRequest) {
  const targets: ReadTarget[] =
    request.target === "ad-group"
      ? ["campaign", "ad-group", "ad"]
      : [request.target];
  return targets.map((target) => {
    if (target === request.target) return { ...request, derived: false };
    const url = new URL(request.url);
    const segment = {
      campaign: "campaign",
      "ad-group": "adgroup",
      ad: "ad",
    }[target];
    const replaced = url.pathname.replace(
      /\/(campaign|adgroup|ad)\/list(?=\/|$)/i,
      `/${segment}/list`,
    );
    if (replaced === url.pathname) return { ...request, derived: false };
    url.pathname = replaced;
    return { ...request, target, url: url.toString(), derived: true };
  });
}

function createAllStatusTemplatePairs(request: {
  target: StatusTarget;
  url: string;
  method: "GET" | "POST";
  body: string | undefined;
  contentType: string | undefined;
  headers: Record<string, string>;
}) {
  const targets: StatusTarget[] =
    request.target === "ad-group-status"
      ? ["campaign-status", "ad-group-status", "ad-status"]
      : [request.target];
  return targets.flatMap((target) => {
    const adapted = adaptStatusRequest(request, target);
    const transformed = transformStatusRequest(adapted.url, adapted.body);
    const derived = target !== request.target;
    return [
    {
      ...adapted,
      url: transformed.originalUrl,
      body: transformed.originalBody,
      action: transformed.originalAction,
      derived,
    },
    {
      ...adapted,
      url: transformed.oppositeUrl,
      body: transformed.oppositeBody,
      action: oppositeAction(transformed.originalAction),
      derived,
    },
    ];
  });
}

function adaptStatusRequest(
  request: {
    target: StatusTarget;
    url: string;
    method: "GET" | "POST";
    body: string | undefined;
    contentType: string | undefined;
    headers: Record<string, string>;
  },
  target: StatusTarget,
) {
  if (target === request.target) return request;
  const url = new URL(request.url);
  url.pathname = replaceStatusPathLevel(url.pathname, target);
  renameEntityIdParams(url.searchParams, target);
  let body = request.body;
  if (body) {
    const trimmed = body.trim();
    if (isMultipartBody(request.contentType, body)) {
      const renamed = rewriteMultipartFields(body, (field) =>
        multipartEntityListKeys.has(field.name.toLowerCase())
          ? { name: targetMultipartEntityListKey(target, url.pathname) }
          : undefined,
      );
      if (renamed.changes === 0) {
        throw new TikTokCurlImportError(
          "状态 cURL 的 multipart 请求体中未找到广告对象列表字段。",
        );
      }
      body = renamed.body;
      if (
        target === "ad-status" &&
        url.pathname.toLowerCase().includes("/overture/")
      ) {
        const copied = copyMultipartField(
          body,
          "creative_list",
          "aco_creative_list",
        );
        if (!copied.added) {
          throw new TikTokCurlImportError(
            "启停 cURL 无法生成最终广告请求所需的 aco_creative_list 字段。",
          );
        }
        body = copied.body;
      }
    } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        body = JSON.stringify(renameEntityIdJson(JSON.parse(body), target));
      } catch {
        throw new TikTokCurlImportError(
          "状态 cURL 的 JSON 请求体无法解析，请重新复制单个请求。",
        );
      }
    } else {
      const params = new URLSearchParams(body);
      renameEntityIdParams(params, target);
      body = params.toString();
    }
  }
  return { ...request, target, url: url.toString(), body };
}

function replaceStatusPathLevel(pathname: string, target: StatusTarget): string {
  const isOverture = pathname.toLowerCase().includes("/overture/");
  const segment = {
    "campaign-status": "campaign",
    "ad-group-status": isOverture ? "ad" : "adgroup",
    "ad-status": isOverture ? "creative" : "ad",
  }[target];
  const levelPattern =
    /\/(campaign|adgroup|ad|creative)(?=\/[^/]*(?:status|update)[^/]*(?:\/|$))/i;
  if (!levelPattern.test(pathname)) {
    throw new TikTokCurlImportError(
      "状态 cURL 路径无法安全扩展到三个层级，请重新复制标准 update/status 请求。",
    );
  }
  const replaced = pathname.replace(levelPattern, `/${segment}`);
  return target === "ad-status" && isOverture
    ? replaced.replace(
        /\/api\/v3\/i18n\/overture\//i,
        "/api/v2/i18n/overture/",
      )
    : replaced;
}

const entityIdKeys = new Set([
  "campaign_id",
  "campaign_ids",
  "adgroup_id",
  "adgroup_ids",
  "ad_group_id",
  "ad_group_ids",
  "ad_id",
  "ad_ids",
  "creative_id",
  "creative_ids",
]);

const multipartEntityListKeys = new Set([
  "campaign_list",
  "adgroup_list",
  "ad_group_list",
  "ad_list",
  "creative_list",
  "aco_creative_list",
]);

function targetMultipartEntityListKey(
  target: StatusTarget,
  pathname: string,
): string {
  const isOverture = pathname.toLowerCase().includes("/overture/");
  if (target === "campaign-status") return "campaign_list";
  if (target === "ad-group-status") {
    return isOverture ? "ad_list" : "adgroup_list";
  }
  return isOverture ? "creative_list" : "ad_list";
}

function targetEntityIdKey(target: StatusTarget, plural: boolean): string {
  if (target === "campaign-status") return plural ? "campaign_ids" : "campaign_id";
  return plural ? "ad_ids" : "ad_id";
}

function renameEntityIdParams(params: URLSearchParams, target: StatusTarget): void {
  for (const key of [...params.keys()]) {
    if (!entityIdKeys.has(key.toLowerCase())) continue;
    const values = params.getAll(key);
    params.delete(key);
    const nextKey = targetEntityIdKey(target, key.toLowerCase().endsWith("_ids"));
    for (const value of values) params.append(nextKey, value);
  }
}

function renameEntityIdJson(value: unknown, target: StatusTarget): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => renameEntityIdJson(item, target));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalized = key.toLowerCase();
      const nextKey = entityIdKeys.has(normalized)
        ? targetEntityIdKey(target, normalized.endsWith("_ids"))
        : key;
      return [nextKey, renameEntityIdJson(item, target)];
    }),
  );
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
    if (isMultipartBody(undefined, body)) {
      bodyResult = transformStatusMultipart(body);
      if (bodyResult) oppositeBody = String(bodyResult.opposite);
    } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
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

function transformStatusMultipart(body: string): StatusTransformResult | null {
  let action: AutomationAction | null = null;
  const rewritten = rewriteMultipartFields(body, (field) => {
    if (!isStatusKey(field.name)) return undefined;
    const detected = detectStatusValue(field.value.trim());
    if (!detected) return undefined;
    if (action && action !== detected.action) {
      throw new TikTokCurlImportError("状态 cURL 中存在互相冲突的状态字段。");
    }
    action = detected.action;
    return { value: String(detected.opposite) };
  });
  return action ? { action, opposite: rewritten.body } : null;
}

function isStatusKey(key: string): boolean {
  return /(?:^|_)(?:status|operation|operation_status|opt_status)$/.test(
    key.toLowerCase(),
  );
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
  let quote: "single" | "double" | "ansi-single" | null = null;
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
    if (quote === "ansi-single") {
      if (character === "'") {
        quote = null;
      } else if (character === "\\") {
        const decoded = decodeAnsiCEscape(input, index);
        current += decoded.value;
        index = decoded.endIndex;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = null;
      else if (character === "\\") escaped = true;
      else current += character;
      continue;
    }
    if (character === "$" && input[index + 1] === "'") {
      quote = "ansi-single";
      index += 1;
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

function decodeAnsiCEscape(
  input: string,
  slashIndex: number,
): { value: string; endIndex: number } {
  const next = input[slashIndex + 1];
  if (next === undefined) {
    throw new TikTokCurlImportError("cURL 命令的 ANSI-C 转义不完整。");
  }
  const simple: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    e: "\u001b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\u000b",
    "\\": "\\",
    "'": "'",
    '"': '"',
  };
  if (next in simple) {
    return { value: simple[next]!, endIndex: slashIndex + 1 };
  }
  if (next === "x") {
    const hex = input.slice(slashIndex + 2, slashIndex + 4);
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      return {
        value: String.fromCharCode(Number.parseInt(hex, 16)),
        endIndex: slashIndex + 3,
      };
    }
  }
  return { value: next, endIndex: slashIndex + 1 };
}
