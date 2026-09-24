# 通用配置

这个文件只说明接口形状，不包含可用凭据、账户名、Base token 或表 ID。使用者应把实际值放在本机配置或当前请求中。

## 飞书凭据

`feishu_read.py` 需要一个本地 JSON 文件，至少包含：

```json
{
  "appId": "cli_xxx",
  "appSecret": "只保存在本机，不要提交到仓库",
  "baseToken": "可选：也可以每次传 --base",
  "tableId": "可选：也可以每次传 --table"
}
```

推荐调用方式：

```bash
python scripts/feishu_read.py \
  --credentials "C:\path\to\feishu.json" \
  --base "自己的baseToken" \
  --list-tables
```

也可以设置 `FEISHU_CREDENTIALS`。脚本只读接口，默认不会写入 Base。`feishu_admin.py` 具有写权限，只有在请求者明确要求建表或导入初值时才使用，并且仍需显式传入目标 Base。

## 建议的表结构

### 品库（每个账户一张）

| 字段 | 用途 |
|---|---|
| `编码` | 品的稳定根编码；也是去重和匹配主键 |
| `品名` | 生成系列名和广告组名的基名 |
| `年龄` | 导入表年龄定向，可为空 |
| `性别` | `不限`、`男` 或 `女`，可为空 |
| `url` | 商品页或落地页，可为空 |

表名可以采用账户显示名，但每次都用 `--list-tables` 现查，不要把 table ID 固定在 skill 或脚本里。

### 素材源代码库

至少提供 `编码` 和 `代码合集`。同一编码可以有多行，每行对应一个广告组批次；`代码合集` 用分号拼接多个视频代码。一个字段里有 `A/B` 时，查询索引应把它拆成两个子编码。

## MCP 输入

skill 不绑定某个 MCP 实现。实现需要提供与下列语义等价的只读操作：

```text
list_accounts()
list_campaigns(accountId, verdict="all")
list_campaigns(accountId, verdict="stopped")
list_ad_groups(accountId)
check_names(accountId, campaignNames, adGroupNames)
```

响应字段至少应能提供系列名、系列状态、创建时间、累计花费、累计转化，以及广告组所属系列和投放状态。若接口默认分页或截断，必须翻页到完整结果。

## 计划 JSON

`export_template.py` 接受如下结构：

```json
{
  "workbooks": [
    {
      "name": "account-20260921.xlsx",
      "rows": [
        ["系列名", "广告组名", "video-001;video-002", "https://example.com/p", "18-24;25-34", "不限", "CODE001"]
      ]
    }
  ]
}
```

每行必须是七个字符串，顺序固定为 `推广系列名称`、`广告组名称`、`视频代码`、`产品 URL`、`年龄`、`性别`、`编码`。脚本会拒绝超过 500 行或 5000 条广告的单文件。
