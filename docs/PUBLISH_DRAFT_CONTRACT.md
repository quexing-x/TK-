# 发布已存在的草稿广告组

2026-08-25 真机抓包解出的接口契约。**已实现**，代码在
`packages/core/src/publish-draft.ts` 与 `CookieAdsProvider.publishExistingDrafts`，
入口是扩组记录里「结果未知」那一行的「发布草稿」按钮。这份文档保留为事实底稿。

实现时相对本文档的三处偏离，见文末「落地时的取舍」。

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

## 落地时的取舍

**没有新增能力项，闸门复用 `copy-ads`。** 同一条创建会话 cURL、同一个发布接口，本质是把
一次已经授权过的扩组做完最后一步。新增能力就得升 `capabilityVersion`，那会让所有存量账户
弹「契约已更新，请重新检测连接」——为一个收尾动作付这个代价不值，也顺带绕开了上面那条
「三处同改」的坑。

**发布前多补一次 `snap/batch_create_cta_id`。** 抓包里没有这一步，因为界面建的草稿自带
CTA；而这里要发的草稿是 `ad_snap/copy` 克隆出来的，扩组流程正是在复制之后才补 CTA，说明
克隆不带可用的行动引导。省掉它会被 TikTok 以「缺少行动引导」拒绝。

**一律发成暂停（`is_status_disabled: true`）。** 原始扩组当时选的是「立即投放」还是
「先关着」没有记录在案。把一个组悄悄开起来烧钱，比让人多点一次开关严重得多。

另外，创意归属那条坑按「拿不准就不发」处理：`sketch/creative/list` 能给出完整归属就按归属
分创意；给不出，只有当 `save_by_sketch` 自己证明该系列下就这一个广告组草稿时才继续，否则
停手让人去后台手动发。

## 2026-08-26 真机验证

拿 `新空调服_新-0813-060000-1`（全娘+8-TT-002，8/12 的草稿）走了完整链路。

**第一次失败，暴露了一个本文档没有的必需步骤。** TikTok 明确拒绝：
`validate_start_time_before_now_error: 开始时间不能早于当前时间`。要收口的草稿按定义就是
放了几天的，`start_time` 必然过期——**这条路径上 `ad_snap/save` 不是可选的**，本文档说的
「未改动的草稿可以跳过」只对刚建出来的草稿成立。补了一步：开始时间过期就顶到 now+5min
（只动排期，预算出价原样保留），没过期则一个写请求都不发。

**第二次成功。** 核对到的事实：

- 广告组列表里出现 `1873320474247281`，`ad_status = ad_disable`，创建时间就是当天，
  与那条 8/12 同名的 `ad_delete` 旧组是两个对象。
- **TikTok 把 `ad_sketch_id` 原样用作发布后的广告组 ID**，所以返回值里两者相同不是 bug。
- 发布后 `sketch/ad/list` 里少了这一条——但**要等异步任务真正跑完**。刚发完立刻查，它还在
  列表里且因为 `ad_snap/save` 更新了修改时间而排到了最前面。拿「草稿是否还在列表里」当即时
  判据会得到相反的结论。
- 终态是 `ad_disable` 而不是本文档预测的 `ad_audit`，因为我们带了 `is_status_disabled`。
  对 `reconcileExpandTask` 无影响：只要不是 `ad_create` 就算收口。

其余 8 条草稿按用户要求原样留着。
