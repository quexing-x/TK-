import {
  CookieConnectionSettingsSchema,
  CookieCredentialInputSchema,
  type CookieConnectionSettings,
  type ProviderCredentialInput,
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
    target: "health" | "campaign" | "ad-group" | "ad";
  };
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
    url.searchParams.get("advertiserId");
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

  const settings = CookieConnectionSettingsSchema.parse({
    kind: "cookie",
    advertiserId,
    healthUrl: "",
    campaignsUrl: "",
    adGroupsUrl: "",
    adsUrl: "",
  });
  const credential = CookieCredentialInputSchema.parse({
    kind: "cookie",
    cookie,
    csrfToken: csrf?.value,
    csrfHeaderName: csrf?.name ?? "x-csrftoken",
    userAgent,
    requestTemplates: [
      {
        target,
        url: url.toString(),
        method,
        body,
        contentType,
      },
    ],
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
): "health" | "campaign" | "ad-group" | "ad" {
  const normalized = pathname.toLowerCase();
  if (normalized.includes("/adgroup/list")) return "ad-group";
  if (normalized.includes("/campaign/list")) return "campaign";
  if (normalized.includes("/ad/list")) return "ad";
  return "health";
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
