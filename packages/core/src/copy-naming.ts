import { stripAutomaticAdGroupNameSuffixes } from "./launch.js";

/** TikTok 的系列/广告组名称上限。截断时必须保留尾部的日期与序号。 */
export const MAX_GENERATED_NAME_LENGTH = 512;

/**
 * 清洗自动生成的后缀。系列名与广告组名共用同一套规则，避免重复扩量时后缀不断
 * 累积成 `A-0730-1-0731-1`。
 */
export function stripGeneratedNameSuffixes(sourceName: string): string {
  return stripAutomaticAdGroupNameSuffixes(sourceName);
}

export function monthDaySuffix(at: Date, timeZone?: string): string {
  if (!timeZone) {
    return `${String(at.getMonth() + 1).padStart(2, "0")}${String(at.getDate()).padStart(2, "0")}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${month}${day}`;
}

/**
 * 在 512 字符上限内截断，但**保留尾部**（日期与序号）。从头部截会把序号一起截
 * 掉，反而制造重名。
 */
export function truncateGeneratedName(name: string): string {
  if (name.length <= MAX_GENERATED_NAME_LENGTH) return name;
  const tail = name.slice(-MAX_GENERATED_NAME_LENGTH);
  return tail;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 计算下一个可用序号。
 *
 * 关键点：序号必须从【账户里已经存在的同前缀名称】往后接，而不是固定从 1 开始。
 * 固定从 1 开始时，同一天对同一个源做第二次扩量必然撞上第一次的名字，创建会被
 * TikTok 直接拒绝，用户看到的是一个没有解释的失败。
 */
export function nextNameSerial(
  existingNames: Iterable<string>,
  baseName: string,
  dateSuffix: string,
): number {
  const pattern = new RegExp(`^${escapeRegExp(`${baseName}-${dateSuffix}-`)}([1-9]\\d*)$`);
  let max = 0;
  for (const name of existingNames) {
    const matched = pattern.exec(name.trim());
    const serial = matched ? Number(matched[1]) : 0;
    if (Number.isFinite(serial) && serial > max) max = serial;
  }
  return max + 1;
}

export interface GeneratedNamePlan {
  /** 清洗并加上日期后的基名，例如 `夏季系列-0730`。 */
  baseName: string;
  /** 逐个副本的最终名称。 */
  names: string[];
  /** 本批次占用的名称，供调用方并入预留集合防止批内自撞。 */
  reserved: Set<string>;
}

/**
 * 生成 `{清洗后源名}-{MMDD}-{序号}` 序列，序号从账户现状往后接，并跳过所有已被
 * 占用的名称（包括本批次已经预留的）。
 */
export function planGeneratedNames(input: {
  sourceName: string;
  count: number;
  at: Date;
  timeZone?: string;
  /** 账户内同层级已存在的名称。 */
  existingNames?: Iterable<string>;
  /** 本批次已经预留但尚未创建的名称。 */
  reservedNames?: Iterable<string>;
}): GeneratedNamePlan {
  const dateSuffix = monthDaySuffix(input.at, input.timeZone);
  const cleaned = stripGeneratedNameSuffixes(input.sourceName);
  const baseName = `${cleaned}-${dateSuffix}`;
  const taken = new Set<string>();
  for (const name of input.existingNames ?? []) taken.add(name.trim());
  for (const name of input.reservedNames ?? []) taken.add(name.trim());

  let serial = nextNameSerial(taken, cleaned, dateSuffix);
  const names: string[] = [];
  const reserved = new Set<string>();
  while (names.length < Math.max(0, input.count)) {
    const candidate = truncateGeneratedName(`${baseName}-${serial}`);
    serial += 1;
    // 序号是按最大值 +1 起编的，正常不会撞；但账户里可能存在用户手工起的同名
    // 对象，所以仍然逐个跳过已占用的名字。
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    reserved.add(candidate);
    names.push(candidate);
  }
  return { baseName, names, reserved };
}

export class DuplicateNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateNameError";
  }
}

/**
 * 在发出任何写请求之前拦下重名。系列名在账户内必须唯一——发布后的终态核验是按
 * 系列名精确匹配的，出现多个同名系列时核验无法判定哪个是本次创建的。
 */
export function assertCampaignNameAvailable(
  existingCampaignNames: Iterable<string>,
  requestedName: string,
  reservedNames: Iterable<string> = [],
): void {
  const wanted = requestedName.trim();
  for (const name of existingCampaignNames) {
    if (name.trim() === wanted) {
      throw new DuplicateNameError(
        `推广系列名称“${wanted}”已存在于该账户；系统不会擅自改名，请调整命名后重试。`,
      );
    }
  }
  for (const name of reservedNames) {
    if (name.trim() === wanted) {
      throw new DuplicateNameError(
        `推广系列名称“${wanted}”在本批次中重复；系统不会擅自改名，请调整命名后重试。`,
      );
    }
  }
}
