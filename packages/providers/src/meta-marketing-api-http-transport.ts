import {
  MetaMarketingApiMutationRejectedError,
  MetaMarketingApiMutationUnknownError,
  type MetaMarketingApiTransport,
  type MetaMarketingApiTransportMutationRequest,
  type MetaMarketingApiTransportRequest,
} from "./meta-marketing-api-provider.js";

const META_GRAPH_ORIGIN = "https://graph.facebook.com";
const META_REQUEST_TIMEOUT_MS = 15_000;
const META_USAGE_STOP_THRESHOLD = 95;

export class MetaMarketingApiHttpTransport implements MetaMarketingApiTransport {
  private usageStopReason: string | null = null;
  private readonly allowedMutationExternalIds: ReadonlySet<string>;

  constructor(allowedMutationExternalIds: string | readonly string[] = []) {
    const ids = typeof allowedMutationExternalIds === "string"
      ? [allowedMutationExternalIds]
      : [...allowedMutationExternalIds];
    if (ids.some((externalId) => !/^\d+$/.test(externalId))) {
      throw new Error("Meta 状态写入对象 allowlist 包含无效 ID。");
    }
    this.allowedMutationExternalIds = new Set(ids);
  }

  async get(input: MetaMarketingApiTransportRequest): Promise<unknown> {
    assertVersion(input.version);
    assertGetPath(input.path);
    assertAppSecretProof(input.appSecretProof);
    const url = buildGraphUrl(input.version, input.path, {
      ...input.params,
      appsecret_proof: input.appSecretProof,
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Meta Graph GET 传输失败。");
    }
    this.observeUsage(response.headers);
    const payload = await readJson(response, "GET");
    if (!response.ok || isGraphError(payload)) {
      throw new Error(graphFailureMessage("GET", response.status, payload));
    }
    return payload;
  }

  async post(input: MetaMarketingApiTransportMutationRequest): Promise<unknown> {
    assertVersion(input.version);
    assertMutationPath(input.path);
    assertMutationBody(input.body);
    assertAppSecretProof(input.appSecretProof);
    if (!this.allowedMutationExternalIds.has(input.path)) {
      throw new MetaMarketingApiMutationRejectedError(
        "Meta 状态写入对象不在本次对象级 allowlist，未发送请求。",
      );
    }
    if (this.usageStopReason) {
      throw new MetaMarketingApiMutationRejectedError(this.usageStopReason);
    }
    const url = buildGraphUrl(input.version, input.path, {});
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: new URLSearchParams({
          ...input.body,
          appsecret_proof: input.appSecretProof,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MetaMarketingApiMutationUnknownError(
        "Meta Graph POST 传输结果不明，禁止自动重放。",
      );
    }
    this.observeUsage(response.headers);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MetaMarketingApiMutationUnknownError(
        "Meta Graph POST 响应无法解析，远端结果待确认。",
      );
    }
    if (isGraphError(payload) && (response.status < 500 || response.ok)) {
      throw new MetaMarketingApiMutationRejectedError(
        graphFailureMessage("POST", response.status, payload),
      );
    }
    if (!response.ok || !isRecord(payload)) {
      throw new MetaMarketingApiMutationUnknownError(
        `Meta Graph POST 返回 HTTP ${response.status}，远端结果待确认。`,
      );
    }
    return payload;
  }

  private observeUsage(headers: Headers): void {
    for (const name of ["x-app-usage", "x-business-use-case-usage"]) {
      const raw = headers.get(name);
      if (!raw) continue;
      try {
        const usage = JSON.parse(raw) as unknown;
        if (maxNumericValue(usage) >= META_USAGE_STOP_THRESHOLD) {
          this.usageStopReason = `Meta ${name} 已达到安全停写阈值，未发送状态写入。`;
          return;
        }
      } catch {
        // Unparseable optional usage headers do not weaken the fixed request scope.
      }
    }
  }
}

function buildGraphUrl(
  version: string,
  path: string,
  params: Readonly<Record<string, string>>,
): URL {
  const url = new URL(`/${version}/${path}`, META_GRAPH_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function assertVersion(version: string): void {
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Meta Graph API 版本无效。");
}

function assertGetPath(path: string): void {
  if (
    path === "me/permissions"
    || path === "me/adaccounts"
    || /^(?:act_)?\d+$/.test(path)
    || /^\d+\/owned_ad_accounts$/.test(path)
    || /^act_\d+\/(?:campaigns|adsets|ads)$/.test(path)
    || /^act_\d+\/insights$/.test(path)
  ) return;
  throw new Error("Meta Graph GET 路径不在允许范围内。");
}

function assertMutationPath(path: string): void {
  if (!/^\d+$/.test(path)) {
    throw new MetaMarketingApiMutationRejectedError(
      "Meta 状态写入对象 ID 无效，未发送请求。",
    );
  }
}

function assertMutationBody(body: Readonly<Record<string, string>>): void {
  const entries = Object.entries(body);
  if (
    entries.length !== 1
    || entries[0]?.[0] !== "status"
    || !["ACTIVE", "PAUSED"].includes(entries[0]?.[1] ?? "")
  ) {
    throw new MetaMarketingApiMutationRejectedError(
      "Meta 状态写入正文不在允许范围内，未发送请求。",
    );
  }
}

function assertAppSecretProof(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Meta appsecret_proof 格式无效，未发送请求。");
  }
}

async function readJson(response: Response, method: "GET"): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Meta Graph ${method} 响应无法解析。`);
  }
}

function graphFailureMessage(method: "GET" | "POST", status: number, payload: unknown): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const code = typeof error?.code === "number" ? `，code ${error.code}` : "";
  const subcode = typeof error?.error_subcode === "number"
    ? `，subcode ${error.error_subcode}`
    : "";
  return `Meta Graph ${method} 明确失败（HTTP ${status}${code}${subcode}）。`;
}

function isGraphError(value: unknown): boolean {
  return isRecord(value) && isRecord(value.error);
}

function maxNumericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Math.max(0, ...value.map(maxNumericValue));
  if (isRecord(value)) return Math.max(0, ...Object.values(value).map(maxNumericValue));
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
