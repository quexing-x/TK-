export interface MultipartField {
  name: string;
  value: string;
  nameStart: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
}

export function isMultipartBody(
  contentType: string | undefined,
  body: string,
): boolean {
  return (
    contentType?.toLowerCase().includes("multipart/form-data") === true ||
    (/^--/.test(body) && /content-disposition:\s*form-data/i.test(body))
  );
}

export function parseMultipartFields(body: string): MultipartField[] {
  const fields: MultipartField[] = [];
  const disposition = /content-disposition:[^\r\n]*\bname="([^"]+)"/gi;
  for (const match of body.matchAll(disposition)) {
    if (match.index === undefined) continue;
    const matchedText = match[0];
    const name = match[1];
    if (!matchedText || !name) continue;
    const nameOffset = matchedText.lastIndexOf(name);
    const nameStart = match.index + nameOffset;
    const headerBreak = findHeaderBreak(body, match.index + matchedText.length);
    if (!headerBreak) continue;
    const valueStart = headerBreak.index + headerBreak.length;
    const valueEnd = findBoundaryStart(body, valueStart);
    if (valueEnd < valueStart) continue;
    fields.push({
      name,
      value: body.slice(valueStart, valueEnd),
      nameStart,
      nameEnd: nameStart + name.length,
      valueStart,
      valueEnd,
    });
  }
  return fields;
}

export function rewriteMultipartFields(
  body: string,
  transform: (
    field: MultipartField,
  ) => { name?: string; value?: string } | undefined,
): { body: string; changes: number; matched: number } {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let changes = 0;
  // `matched` counts every field the transform claimed (returned a non-undefined
  // result for), independent of whether the replacement text actually differs
  // from what was already there. Callers that need to know "did we find a field
  // to target this entity" must use `matched`, not `changes` — a field whose
  // captured value already happens to equal the desired value produces zero
  // text diff but is still a real match. Conflating the two made status writes
  // silently no-op (and get rejected as "no matching field") whenever the
  // target id happened to equal whatever id was captured in the imported cURL.
  let matched = 0;
  for (const field of parseMultipartFields(body)) {
    const next = transform(field);
    if (!next) continue;
    matched += 1;
    if (next.name !== undefined && next.name !== field.name) {
      replacements.push({
        start: field.nameStart,
        end: field.nameEnd,
        value: next.name,
      });
      changes += 1;
    }
    if (next.value !== undefined && next.value !== field.value) {
      replacements.push({
        start: field.valueStart,
        end: field.valueEnd,
        value: next.value,
      });
      changes += 1;
    }
  }
  replacements.sort((left, right) => right.start - left.start);
  let output = body;
  for (const replacement of replacements) {
    output =
      output.slice(0, replacement.start) +
      replacement.value +
      output.slice(replacement.end);
  }
  return { body: output, changes, matched };
}

export function copyMultipartField(
  body: string,
  sourceName: string,
  targetName: string,
  /**
   * 新字段的值。省略时复制源字段的值。
   *
   * ACO 创意列表必须显式传 "[]"：真实的广告层开关请求里 creative_list 装目标广告、
   * aco_creative_list 是空数组，两者是不同类型的对象。把普通广告 ID 复制进 ACO 列表
   * 会被 TikTok 以 code 4「不支持特定界面」拒绝。
   */
  value?: string,
): { body: string; added: boolean } {
  const fields = parseMultipartFields(body);
  if (
    fields.some(
      (field) => field.name.toLowerCase() === targetName.toLowerCase(),
    )
  ) {
    return { body, added: false };
  }
  const source = fields.find(
    (field) => field.name.toLowerCase() === sourceName.toLowerCase(),
  );
  if (!source) return { body, added: false };

  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const firstLineEnd = body.indexOf(newline);
  if (firstLineEnd <= 0) return { body, added: false };
  const boundary = body.slice(0, firstLineEnd);
  const closingMarker = `${newline}${boundary}--`;
  const closingIndex = body.lastIndexOf(closingMarker);
  if (closingIndex < 0) return { body, added: false };

  const copiedPart = `${newline}${boundary}${newline}Content-Disposition: form-data; name="${targetName}"${newline}${newline}${value ?? source.value}`;
  return {
    body: body.slice(0, closingIndex) + copiedPart + body.slice(closingIndex),
    added: true,
  };
}

function findHeaderBreak(
  body: string,
  from: number,
): { index: number; length: number } | null {
  const windows = body.indexOf("\r\n\r\n", from);
  const unix = body.indexOf("\n\n", from);
  if (windows >= 0 && (unix < 0 || windows <= unix)) {
    return { index: windows, length: 4 };
  }
  return unix >= 0 ? { index: unix, length: 2 } : null;
}

function findBoundaryStart(body: string, from: number): number {
  const windows = body.indexOf("\r\n--", from);
  const unix = body.indexOf("\n--", from);
  if (windows >= 0 && (unix < 0 || windows <= unix)) return windows;
  return unix;
}
