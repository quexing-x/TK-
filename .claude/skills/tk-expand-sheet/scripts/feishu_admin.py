"""品库表的管理工具：建表 / 写入初值。**不是日常流程用的。**

日常出扩组表只读飞书，用 feishu_read.py。这个脚本会写飞书，而品库是投手手工维护的——
误跑一次就可能覆盖掉他的维护结果。只在明确要求「建品库表」「导入品库初值」时用。

所有写操作都幂等：
- 建表按表名查重，已存在就跳过（不会建出两张同名表）
- 写记录前先读现有编码，已存在的跳过（不会写重复行）

用法：
    python feishu_admin.py --create-tables "账户A" "账户B"     # 建表（不填数据）
    python feishu_admin.py --create-tables-from-accounts       # 按 list_accounts 的 6 个账户名建
    python feishu_admin.py --seed <表名> --json rows.json      # 往表里写初值（跳过已存在的编码）
"""

from __future__ import annotations

import argparse
import json
import sys

from feishu_read import (
    API,
    fetch_flat,
    list_tables,
    load_credentials,
    post,
    tenant_token,
)

# 品库的五列。编码放第一个：飞书把第一个字段作为主字段，而编码是我们整套判定的主键。
# 性别做成单选是为了防手滑填出「男性」「Male」这种导入表不认的值；年龄留文本，因为它是
# 分号拼接的多值（18-24;25-34），单选装不下。
CATALOG_FIELDS = [
    {"field_name": "编码", "type": 1},
    {"field_name": "品名", "type": 1},
    {"field_name": "年龄", "type": 1},
    {"field_name": "性别", "type": 3,
     "property": {"options": [{"name": "不限"}, {"name": "男"}, {"name": "女"}]}},
    {"field_name": "url", "type": 1},
]

ACCOUNT_NAMES = [
    "余杭茵未-1PHH",
    "余杭茵未-24HP",
    "双科-TD-全娘+8-TT-002",
    "双科-TD-般朵+8-TT-001",
    "纵姿-251128-1",
    "纵姿0918-1",
]


def create_table(token: str, base_token: str, name: str, existing: dict[str, str]) -> dict:
    if name in existing:
        return {"name": name, "table_id": existing[name], "created": False, "note": "已存在，跳过"}
    data = post(
        f"{API}/bitable/v1/apps/{base_token}/tables",
        {"table": {"name": name, "default_view_name": "品库", "fields": CATALOG_FIELDS}},
        token,
    )
    if data.get("code") != 0:
        raise SystemExit(f"建表失败（{name}）：{data}")
    table_id = (data.get("data") or {}).get("table_id")
    return {"name": name, "table_id": table_id, "created": True}


def seed_rows(token: str, base_token: str, table_id: str, rows: list[dict]) -> dict:
    """批量写行，跳过表里已有的编码。

    先读后写不是为了省请求，是为了幂等：投手可能已经手工填过几行，重跑不该把它们写成两份。
    """
    # 必须用 fetch_flat：fetch_records 的文本列是 [{"text": ...}] 结构，直接 str() 拿去比
    # 永远不相等，判重会静默失效、把已有的行再写一遍。
    existing = fetch_flat(token, base_token, table_id, ["编码"])
    have = {str(record.get("编码", "")).strip() for record in existing}
    have.discard("")

    fresh = [row for row in rows if str(row.get("编码", "")).strip() not in have]
    if not fresh:
        return {"written": 0, "skipped": len(rows), "note": "编码都已存在"}

    written = 0
    # 飞书批量创建单次上限 1000 行，留余量按 500 切。
    for start in range(0, len(fresh), 500):
        chunk = fresh[start:start + 500]
        data = post(
            f"{API}/bitable/v1/apps/{base_token}/tables/{table_id}/records/batch_create",
            {"records": [{"fields": row} for row in chunk]},
            token,
        )
        if data.get("code") != 0:
            raise SystemExit(f"写入失败：{data}")
        written += len(chunk)
    return {"written": written, "skipped": len(rows) - written}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="品库表管理（会写飞书，非日常流程）")
    parser.add_argument("--base", help="base token；省略用凭据里的")
    parser.add_argument("--create-tables", nargs="*", metavar="表名", help="建这些表")
    parser.add_argument("--create-tables-from-accounts", action="store_true",
                        help="按内置的 6 个账户名建表")
    parser.add_argument("--seed", metavar="表名", help="往这张表写初值")
    parser.add_argument("--json", metavar="路径", help="--seed 的数据源：一个 JSON 数组")
    args = parser.parse_args()

    credentials = load_credentials()
    base_token = args.base or credentials["baseToken"]
    token = tenant_token(credentials)

    names: list[str] = []
    if args.create_tables_from_accounts:
        names = list(ACCOUNT_NAMES)
    if args.create_tables:
        names.extend(args.create_tables)

    result: dict = {}

    if names:
        existing = {t.get("name"): t.get("table_id") for t in list_tables(token, base_token)}
        result["tables"] = [create_table(token, base_token, name, existing) for name in names]

    if args.seed:
        if not args.json:
            raise SystemExit("--seed 需要配 --json <路径>")
        with open(args.json, encoding="utf-8") as handle:
            rows = json.load(handle)
        tables = {t.get("name"): t.get("table_id") for t in list_tables(token, base_token)}
        table_id = tables.get(args.seed) or args.seed
        result["seed"] = {"table": args.seed, **seed_rows(token, base_token, table_id, rows)}

    if not result:
        raise SystemExit("没指定动作。用 --create-tables-from-accounts 或 --seed")

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
