#!/usr/bin/env python3
"""提交前的密钥自检。

替代原先那条跑不起来的 `python -m secret_scanner github --min-severity high --strict`
（该模块在本机不存在）。改用 detect-secrets，并按原规则想要的语义收口：

  有高危命中 -> 退出码 1（让流程真的停下来）
  无命中     -> 退出码 0

detect-secrets 原生 `scan` 永远退出 0，所以这里必须包一层——只跑原生命令的话，
"命中则停止" 这条约束是空的。

用法：
  python scripts/secret_scan.py            # 扫 git 已跟踪文件（默认）
  python scripts/secret_scan.py --all      # 扫工作区全部文件
  python scripts/secret_scan.py --quiet    # 只在有命中时输出
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 默认丢弃 KeywordDetector 的命中：它按关键词（secret/token/password）模糊匹配，
# 在真实业务库里报的多是 `"secrets": "node scripts/generate-secrets.mjs"` 这类 npm
# 脚本名和测试里的占位串。误报多了人就学会无视告警，闸门也就失效了。
# 其余 detect-secrets 默认插件（AWS/PrivateKey/GitHub/OpenAI/Stripe/高熵串……）全部保留。
# 需要看关键词命中时用 --include-keywords。
LOW_SIGNAL_TYPE = "Secret Keyword"

# 这些路径天然含凭据或体积巨大，扫它们只会淹掉真正的信号。
EXCLUDE_FILES = (
    r"pnpm-lock\.yaml$"
    r"|\.lock$"
    r"|node_modules/"
    r"|/dist/"
    r"|\\dist\\"
    r"|\.asar$"
    r"|\.claude/worktrees/"
    r"|\.claude\\worktrees\\"
)


def run_scan(all_files: bool) -> dict:
    # 注意：不要用 `--baseline` 来限定插件集。实测（1.5.0）加了 --baseline 之后
    # 扫描不报任何命中——连明文放进去的 AWS key 都测不出来，等于把闸门做成了摆设。
    # 正确做法是让 detect-secrets 用它默认的完整插件集跑，再在下面按插件名过滤掉
    # 低信号项。宁可多扫一遍，也不能让闸门失效。
    command = [
        sys.executable, "-m", "detect_secrets", "scan",
        "--exclude-files", EXCLUDE_FILES,
    ]
    if all_files:
        command.append("--all-files")

    completed = subprocess.run(
        command, cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        raise SystemExit(f"detect-secrets 运行失败（退出码 {completed.returncode}）")
    try:
        return json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as cause:
        raise SystemExit(f"无法解析 detect-secrets 输出：{cause}") from cause


def main() -> int:
    parser = argparse.ArgumentParser(description="提交前密钥自检")
    parser.add_argument("--all", action="store_true", help="扫工作区全部文件，而非仅 git 跟踪文件")
    parser.add_argument("--quiet", action="store_true", help="只在有命中时输出")
    parser.add_argument(
        "--include-keywords",
        action="store_true",
        help="额外报告 KeywordDetector 命中（误报较多，默认丢弃）",
    )
    args = parser.parse_args()

    report = run_scan(args.all)
    raw_results: dict[str, list[dict]] = report.get("results", {})

    # 丢低信号命中。
    results: dict[str, list[dict]] = {}
    skipped = 0
    for path, hits in raw_results.items():
        kept = [
            hit for hit in hits
            if args.include_keywords or hit.get("type") != LOW_SIGNAL_TYPE
        ]
        skipped += len(hits) - len(kept)
        if kept:
            results[path] = kept

    total = sum(len(hits) for hits in results.values())
    if total == 0:
        if not args.quiet:
            note = f"（已忽略 {skipped} 处低信号关键词命中）" if skipped else ""
            print(f"密钥自检通过：无高危命中。{note}")
        return 0

    print(f"密钥自检发现 {total} 处高危命中，需要人工确认：\n")
    for path, hits in sorted(results.items()):
        for hit in hits:
            line = hit.get("line_number", "?")
            kind = hit.get("type", "unknown")
            verified = "已验证有效" if hit.get("is_verified") else "未验证"
            print(f"  {path}:{line}  [{kind}] {verified}")

    print(
        "\n请确认这些是真实凭据还是误报：\n"
        "  - 真实凭据：从代码中移除并作废该凭据，不要提交。\n"
        "  - 误报：在该行加 `# pragma: allowlist secret` 后重跑。\n"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
