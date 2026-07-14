import type { CookieConnectionReadiness } from "@tk-auto/core";

const targets = ["campaign", "ad-group", "ad"] as const;

const targetLabels: Record<(typeof targets)[number], string> = {
  campaign: "广告系列",
  "ad-group": "广告组",
  ad: "最终广告层",
};

export function describeCookieCoverage(
  readiness: Pick<CookieConnectionReadiness, "readTargets" | "statusTargets">,
) {
  const missingReadTargets = targets.filter(
    (target) => !readiness.readTargets.includes(target),
  );
  const missingStatusTargets = targets.filter(
    (target) => !readiness.statusTargets.includes(target),
  );
  const verifiedCount = targets.filter(
    (target) =>
      readiness.readTargets.includes(target) &&
      readiness.statusTargets.includes(target),
  ).length;

  const readMessage = missingReadTargets.length
    ? `读取数据仍缺少${missingReadTargets.map((target) => targetLabels[target]).join("、")}列表 cURL。`
    : "读取数据已覆盖全部三个层级。";
  const statusMessage = missingStatusTargets.length
    ? `启停模板仍缺少${missingStatusTargets.map((target) => targetLabels[target]).join("、")}真实启停 cURL。`
    : "启停模板已覆盖全部三个层级。";
  const availabilityMessage =
    verifiedCount < targets.length
      ? "未补齐层级的自动化保持不可用。"
      : "三个层级的自动化接入均已就绪。";

  return {
    verifiedCount,
    message: `${readMessage}${statusMessage}${availabilityMessage}`,
  };
}
