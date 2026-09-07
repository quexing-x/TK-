"""读飞书多维表格的一张表，把记录以 JSON 吐到 stdout。

为什么要有这个脚本、而不是每次现写请求：
- **中文 field_names 必须走 POST body，不能走 GET 查询串。** 在 Git Bash 里 GET + 中文
  参数会被编码坏掉，飞书回 FieldNameNotFound，看起来像「这个字段不存在」，实际是编码问题。
  用 curl 同样踩这个坑。这里统一用 urllib 发 POST。
- 分页必须走到底。品库和源代码库都是几百上千行，只取第一页会静默少数据——而少掉的行
  在下游表现为「这个品在品库里没有」，是最难查的一类错。

用法：
    python feishu_read.py --table tbl4IgEwXruyusk1
    python feishu_read.py --table tblXXX --fields 编码 品名 年龄 性别 url
    python feishu_read.py --table tblXXX --base bascXXX --raw

凭据取自 %APPDATA%\\TK Ads Automation\\feishu.json（appId / appSecret / baseToken / tableId）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://open.feishu.cn/open-apis"
PAGE_SIZE = 500


def load_credentials() -> dict:
    path = os.path.join(os.environ["APPDATA"], "TK Ads Automation", "feishu.json")
    if not os.path.exists(path):
        raise SystemExit(f"找不到飞书凭据：{path}")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def post(url: str, payload: dict, token: str | None = None) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {error.code} {url}\n{detail}") from error


def get(url: str, token: str) -> dict:
    request = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {error.code} {url}\n{detail}") from error


def list_tables(token: str, base_token: str) -> list[dict]:
    """列出 base 下所有表。用它按表名找品库，不要在别处硬编码 tableId。

    GET 在这里是安全的：URL 里没有中文参数。带中文的请求一律走 POST body。
    """
    tables: list[dict] = []
    page_token: str | None = None
    while True:
        url = f"{API}/bitable/v1/apps/{base_token}/tables?page_size=100"
        if page_token:
            url += f"&page_token={page_token}"
        data = get(url, token)
        if data.get("code") != 0:
            raise SystemExit(f"列表失败：{data}")
        body = data.get("data") or {}
        tables.extend(body.get("items") or [])
        if not body.get("has_more"):
            break
        page_token = body.get("page_token")
        if not page_token:
            break
    return tables


def tenant_token(credentials: dict) -> str:
    data = post(
        f"{API}/auth/v3/tenant_access_token/internal",
        {"app_id": credentials["appId"], "app_secret": credentials["appSecret"]},
    )
    if data.get("code") != 0:
        raise SystemExit(f"换 tenant_access_token 失败：{data}")
    return data["tenant_access_token"]


def fetch_records(token: str, base_token: str, table_id: str, fields: list[str]) -> list[dict]:
    records: list[dict] = []
    page_token: str | None = None
    while True:
        url = f"{API}/bitable/v1/apps/{base_token}/tables/{table_id}/records/search?page_size={PAGE_SIZE}"
        if page_token:
            url += f"&page_token={page_token}"
        payload: dict = {}
        # 不传 field_names 就是全字段。只在明确指定时才限定，避免把没想到的列筛掉。
        if fields:
            payload["field_names"] = fields
        data = post(url, payload, token)
        if data.get("code") != 0:
            raise SystemExit(f"读表失败（table={table_id}）：{data}")
        body = data.get("data") or {}
        records.extend(body.get("items") or [])
        if not body.get("has_more"):
            break
        page_token = body.get("page_token")
        if not page_token:
            break
    return records


def flatten(value):
    """把飞书的富字段压成朴素文本。

    同一列在不同行可能是 str / {"text": ...} / [{"text": ...}] 三种形状，下游按品编码做
    精确匹配，形状不统一会让本来相等的两个编码比不相等。
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, dict):
        for key in ("text", "value", "name", "link"):
            if key in value:
                return flatten(value[key])
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        parts = [flatten(item) for item in value]
        return ", ".join(str(part) for part in parts if str(part))
    return str(value)


def main() -> None:
    # 必须在任何输出之前设好，且 stderr 也要设：Windows 中文版 Python 默认按 cp936 写管道，
    # 飞书的报错信息里带中文字段名，编码不对会变成一串乱码——本来一眼能看出「字段名写错了」，
    # 变成完全无法排查。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="读飞书多维表格一张表")
    parser.add_argument("--table", help="表 ID（tblXXX）。省略则用凭据里的 tableId")
    parser.add_argument("--base", help="多维表格 base token。省略则用凭据里的 baseToken")
    parser.add_argument("--fields", nargs="*", default=[], help="只取这些列；省略取全部")
    parser.add_argument("--raw", action="store_true", help="原样输出，不压平富字段")
    parser.add_argument("--list-tables", action="store_true",
                        help="只列出 base 下所有表（名字 + tableId），用来按表名找品库")
    args = parser.parse_args()

    credentials = load_credentials()
    base_token = args.base or credentials["baseToken"]
    table_id = args.table or credentials["tableId"]

    token = tenant_token(credentials)

    if args.list_tables:
        tables = list_tables(token, base_token)
        print(json.dumps(
            {"base": base_token, "count": len(tables),
             "tables": [{"table_id": t.get("table_id"), "name": t.get("name")} for t in tables]},
            ensure_ascii=False, indent=2))
        return

    records = fetch_records(token, base_token, table_id, args.fields)

    if args.raw:
        payload = records
    else:
        payload = [
            {name: flatten(value) for name, value in (record.get("fields") or {}).items()}
            for record in records
        ]

    print(json.dumps({"table": table_id, "count": len(payload), "records": payload},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
