# 发布已存在的草稿广告组

2026-08-25 真机抓包解出的接口契约。**尚未实现**，这份文档是实现前的事实底稿。

## 背景

扩组是「建草稿 → 发布」两步（`ad_snap/copy` → `async_creation/create_by_snap`）。
发布那步失败时，TikTok 后台会留下一个草稿，本地记一条「结果未知」。

目前没有「拿一个已存在的草稿去发布」的入口：发布需要 snap/sketch 标识，那是建草稿时的
临时产物，失败记录里的 `generated_ids_json` 是空的。

好消息是**草稿能按名字反查**，所以那些没记 ID 的失败记录也找得回来。

## 三步链路

### 1. 找到草稿

```
POST /api/v4/i18n/statistics/sketch/ad/list/
{"query_list":[],"page":1,"limit":20,"sort_order":1,"sort_stat":"modify_time","filters":[]}
```

响应 `data.table[]`（注意是 `table` 不是 `list`）：

```json
{"ad_sketch_id":"1874514740509986",
 "ad_sketch_name":"DM003182 ... 的副本 1",
 "campaign_id":"1874278019329169",
 "campaign_sketch_id":"0"}
```

按 `ad_sketch_name` 匹配失败记录里的 `generated_names_json` 即可定位。

### 2. 由草稿生成 snap

```
POST /api/v4/i18n/creation/snap/save_by_sketch/
{"campaign_id":"1874278019329169","campaign_sketch_id":""}
```

响应直接给出映射——**这是整条链路的关键，有它就不必重建表单**：

```json
{"ad_sketch_id_to_snap_id":{"1874514740509986":"1874514790077570"},
 "creative_sketch_id_to_snap_id":{"1874514740510002":"1874514790079554"}}
```

### 3. 发布

```
POST /api/v4/i18n/creation/async_creation/create_by_snap/
{
  "campaign_id":"1874278019329169",
  "campaign_snap_id":"", "campaign_sketch_id":"",
  "ad_and_creative_snap_info_list":[{
    "ad_id":"", "ad_snap_id":"<步骤2>", "ad_sketch_id":"<步骤1>",
    "creative_snap_info_list":[{
      "creative_id":"", "creative_snap_id":"<步骤2>",
      "creative_sketch_id":"<步骤2 的 key>", "need_publish":true}],
    "need_publish":true}],
  "coming_source_type":6,
  "sketch_publish_source":2,        // 2 = 从草稿发布（新建走 1）
  "is_partial_publish":false,
  "risk_info":{...}
}
```

响应 `{"async_request_id":"...","job_id":"..."}`，code 0。**是异步任务**，返回成功只代表
受理，真实结果要回读广告组列表确认（`ad_status` 由 `ad_create` 变 `ad_audit`）。

`create_by_snap` 就是现在扩组用的那个接口，已经打通过；差别只在 `sketch_publish_source`
和是否带 sketch id。

## 实现时必须留意

- **`ad_snap/save` 不是必需的**。抓包里有它，是因为界面在发布前保存了表单改动。发布未改动
  的草稿可以跳过，省掉重建 4700 字节 `ad_sketch_form_data` 的全部麻烦。
- **一个系列多个草稿时要挑对创意**。`save_by_sketch` 返回该系列下所有 sketch 的映射，
  `creative_sketch_id_to_snap_id` 不带「属于哪个 ad」的信息。抓包里各只有一个所以看不出问题。
  需要用 `/api/v4/i18n/statistics/sketch/creative/list/` 建立 creative→ad 的对应。
- **异步 + 创建类写入**。失败要判 unknown 而非 failed：重试可能建出第二个对象。
- 签名参数（msToken / X-Bogus / X-Gnarly）沿用会话 cURL，与其他派生写入一致。
- 新增能力时记得三处同改：`provider.capabilities`、`capabilityVersion`、`resolveCapabilities`
  ——2026-08-25 的提额规则就因为漏了后两处，静默失效了一整天。
