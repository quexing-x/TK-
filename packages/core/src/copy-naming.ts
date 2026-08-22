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

/** 账户本地日历日，格式 `YYYY-MM-DD`。「今天」的判定一律走它，不用 UTC 日期。 */
export function dateKeyInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** 投放日期 + 时间，格式 `MMDD-HHMMSS`，按账户时区取值。 */
export function dateTimeSuffix(at: Date, timeZone?: string): string {
  if (!timeZone) {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${monthDaySuffix(at)}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${monthDaySuffix(at, timeZone)}-${pick("hour")}${pick("minute")}${pick("second")}`;
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

export interface GeneratedNamePlan {
  /** 清洗并加上投放日期后的基名，例如 `夏季系列-0730`。 */
  baseName: string;
  /** 逐个副本的最终名称。 */
  names: string[];
  /** 本批次占用的名称，供调用方并入预留集合防止批内自撞。 */
  reserved: Set<string>;
}

/**
 * 生成 `{清洗后源名}-{MMDD}-{HHMMSS}` 序列，时间取【投放时刻】：定时投放用排期
 * 时间，立即投放用当前时间。
 *
 * 名字带到秒之后就不再依赖「账户里已有哪些名字」来定序号了——这一点是刻意的。
 * 旧规则的序号必须从账户现状往后接，而本地快照最长可能滞后一整轮轮询，账户里
 * 刚建好、还没被同步捕获的对象会被误判成名字可用，发布时才被 TikTok 判重名。
 * 同一批的多个副本按秒递增区分，因此批内也不会自撞。
 *
 * existingNames / reservedNames 仍然接受，但只作为跳过用的兜底集合（应对手工
 * 起了同名对象的情况），不再参与序号计算，允许调用方传入过期快照。
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
  const cleaned = stripGeneratedNameSuffixes(input.sourceName);
  const baseName = `${cleaned}-${monthDaySuffix(input.at, input.timeZone)}`;
  const taken = new Set<string>();
  for (const name of input.existingNames ?? []) taken.add(name.trim());
  for (const name of input.reservedNames ?? []) taken.add(name.trim());

  const names: string[] = [];
  const reserved = new Set<string>();
  const wanted = Math.max(0, input.count);
  // 每个副本往后推一秒。上限留出充足余量：撞名只可能来自用户手工起的同名对象，
  // 正常情况下第一个候选就可用。
  for (let offset = 0; names.length < wanted && offset < wanted + 600; offset += 1) {
    const at = new Date(input.at.getTime() + offset * 1000);
    const candidate = truncateGeneratedName(
      `${cleaned}-${dateTimeSuffix(at, input.timeZone)}`,
    );
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
