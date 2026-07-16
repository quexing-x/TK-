import { readFileSync } from "node:fs";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const harPath = process.argv[2];
if (!harPath) throw new Error("Usage: tsx scripts/analyze-creation-har.mts <har-path>");
const requestedIndexes = new Set(process.argv.slice(3).map(Number).filter(Number.isInteger));

const document = JSON.parse(readFileSync(harPath, "utf8")) as {
  log?: { entries?: Array<Record<string, unknown>> };
};
const entries = document.log?.entries ?? [];
const candidates = entries.map((entry, originalIndex) => ({ entry, originalIndex })).filter(({ entry, originalIndex }) => {
  if (requestedIndexes.size > 0) return requestedIndexes.has(originalIndex);
  const request = entry.request as { url?: string } | undefined;
  if (!request?.url) return false;
  const pathname = new URL(request.url).pathname.toLowerCase();
  return pathname.includes("/creation/") || /(?:snap|sketch|draft)/.test(pathname);
});

const valueLabels = new Map<string, string>();
let nextValueLabel = 1;

function parseJsonText(value: unknown, encoding?: unknown): JsonValue | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = encoding === "base64" ? Buffer.from(value, "base64").toString("utf8") : value;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function collectPaths(value: JsonValue | undefined, prefix = "$", result = new Set<string>()): Set<string> {
  if (value === undefined || value === null || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPaths(item, `${prefix}[*]`, result));
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    const safeKey = /^\d{8,}$/.test(key) ? "{*}" : key;
    const path = `${prefix}.${safeKey}`;
    result.add(path);
    collectPaths(child, path, result);
  }
  return result;
}

function collectIdRelations(value: JsonValue | undefined, side: "req" | "res", prefix = "$", result: string[] = []): string[] {
  if (value === undefined || value === null || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectIdRelations(item, side, `${prefix}[*]`, result));
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if ((typeof child === "string" || typeof child === "number") && String(child).length > 0 && /(?:^id$|_id$|_ids$)/.test(key)) {
      const identity = String(child);
      let label = valueLabels.get(identity);
      if (!label) {
        label = `V${nextValueLabel++}`;
        valueLabels.set(identity, label);
      }
      result.push(`${side}:${path}=${label}`);
    }
    collectIdRelations(child, side, path, result);
  }
  return result;
}

const endpointCounts = new Map<string, number>();
for (const { entry } of candidates) {
  const request = entry.request as { url: string };
  const pathname = new URL(request.url).pathname;
  endpointCounts.set(pathname, (endpointCounts.get(pathname) ?? 0) + 1);
}

console.log(JSON.stringify({ totalEntries: entries.length, candidateEntries: candidates.length, endpointCounts: Object.fromEntries(endpointCounts) }, null, 2));

for (const [candidateIndex, { entry, originalIndex }] of candidates.entries()) {
  const request = entry.request as { method?: string; url: string; postData?: { text?: string } };
  const response = entry.response as { status?: number; content?: { text?: string; encoding?: string } } | undefined;
  const requestBody = parseJsonText(request.postData?.text);
  const responseBody = parseJsonText(response?.content?.text, response?.content?.encoding);
  const pathname = new URL(request.url).pathname;
  const requestPaths = [...collectPaths(requestBody)].sort();
  const responsePaths = [...collectPaths(responseBody)].sort();
  const relations = [...collectIdRelations(requestBody, "req"), ...collectIdRelations(responseBody, "res")];
  console.log(JSON.stringify({
    index: candidateIndex + 1,
    harIndex: originalIndex,
    startedDateTime: entry.startedDateTime,
    method: request.method,
    pathname,
    status: response?.status,
    requestPaths,
    responsePaths,
    idRelations: relations,
  }, null, 2));
}
