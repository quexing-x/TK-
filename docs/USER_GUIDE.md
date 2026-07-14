# TK Ads 自动化操作使用手册

版本：0.3.1  
更新日期：2026-07-14

本手册覆盖本地启动、Cookie 会话接入、TikTok Marketing API 接入、双 Provider 切换、自动化开关、配置管理、阈值配置与只读同步。

> 本文件由 `packages/manual/guide.json` 自动生成，请勿直接编辑。

## 1. 首次启动

当前版本是本地优先工具，不需要公网服务器。API 和数据库只在本机运行。

1. 在项目目录执行 pnpm install。
2. 执行 pnpm dev，同时启动本地 API 和 Web 管理界面。
3. 浏览器打开 http://127.0.0.1:5173。
4. 首次启动会创建 data/tk-automation.db 和演示广告账户。
5. 先在接入管理完成参数、凭据和连接检测，再执行只读同步。

注意事项：

- 本地 API 默认监听 127.0.0.1:3100，不对局域网和公网开放。
- 当前阶段不会自动暂停、复制或删除 TikTok 广告。

## 2. Cookie 会话接入

Cookie 方案适合自有、已授权的 TikTok Ads 账户。推荐使用一次性 cURL 快速导入，系统会自动提取账号、请求方式、Payload、Cookie 和 CSRF Token。

1. 使用 Chrome 正常登录 TikTok Ads Manager，并切换到目标广告账户。
2. 按 F12 打开开发者工具，进入 Network，选择 Fetch/XHR。
3. 在 Network 左上角 Filter 输入框输入 /adgroup/list/?。
4. 回到 TikTok 页面点击“广告组”，再点击页面上的“刷新数据”，或按 Shift + R 刷新数据。
5. Network 中应出现一到两条名称类似 list/?aadvid=... 的请求；选择最后一条状态为 200、Response 为 JSON 的请求。
6. 在该请求上点击鼠标右键，选择 Copy → Copy as cURL (bash)。Copy as cURL (bash) 是右键菜单中的复制选项，不是请求名称。
7. 如果 /adgroup/list/? 没有结果，在 Filter 中改为 /campaign/list/?，回到 TikTok 页面点击“推广系列”并刷新数据。不要选择 report、batch、append 或 update_status 请求。
8. 进入接入管理的 Cookie 会话，把完整 cURL 粘贴到快速导入区域。
9. 点击加密导入并检测。系统会自动识别 Advertiser ID、请求方法、Payload、Cookie、CSRF Token 和请求类型。
10. 状态显示连接正常即完成接入。完整请求及其中的 msToken、Cookie 只保存在 Windows DPAPI 加密保险库中。
11. 如需同步另外两类数据，分别复制对应列表请求的 cURL 并再次导入；系统会按系列、广告组和广告类型自动合并。
12. 只有快速导入无法识别时，才展开高级手动接入填写各字段。

注意事项：

- Cookie 是登录凭据，只能用于本人或明确授权的账户，不要通过聊天、邮件或公开文档传递。
- 不要通过切换广告开关来获取 update_status 请求，接入测试不得改变真实广告状态。
- 完整 cURL 可能包含 msToken 和签名参数，系统不会把这些内容明文写入 SQLite。
- Cookie 失效后重新登录 TikTok，在接入管理覆盖保存新凭据即可，阈值和开关不会丢失。
- 系统禁止把 Cookie 请求发送到非 TikTok 域名，并禁止自动跟随重定向。

## 3. TikTok Marketing API 接入

官方 API 适合长期稳定运行。当前版本支持手动填入长期 Access Token，后续可以增加浏览器 OAuth 授权。

1. 登录 TikTok for Business Developers，注册开发者并创建 Developer App。
2. 按实际功能申请 Campaign Management 和 Reporting 等权限，不要申请暂时不使用的权限。
3. 配置授权回调地址。桌面或本地模式可使用 TikTok 允许的 localhost 回调。
4. 让广告账户持有人打开授权链接并授权，使用 auth_code 换取长期 Access Token。
5. 记录授权响应中的 advertiser_ids，选择要管理的 advertiser ID。
6. 在接入管理切换到 Marketing API，填写 advertiser ID，并保存接入参数。
7. 将 Access Token 填入凭据区域并加密保存。App Secret 不需要保存在本工具中。
8. 点击连接检测。系统会通过官方 campaign/get 只读接口验证 Token 与广告账户权限。
9. 检测通过后点击只读同步，系统依次读取 campaign/get、adgroup/get 和 ad/get。

注意事项：

- Access Token 的权限以广告主实际授权范围为准。
- 当前仅同步每类第一页、最多 1000 条；分页增量同步将在后续版本实现。
- 切勿把 App Secret、Access Token 写入代码、Git 或公开文档。

## 4. Cookie 与 API 自由切换

两种 Provider 的参数和凭据按账户独立保存，切换不会删除另一种接入配置。

1. 分别在接入管理完成 Cookie 和 Marketing API 配置及连接检测。
2. 进入配置管理，在接入方式中选择当前要使用的 Provider。
3. 保存配置后，自动化开关、阈值和未来规则引擎会使用选中的 Provider。
4. 切换前先确认目标 Provider 状态为连接正常；未通过检测时不要开启真实自动执行。

注意事项：

- Provider 切换只改变数据和操作通道，不改变账户阈值与自动化开关。

## 5. 自动化开关

自动化开关定义规则引擎允许使用哪些能力，不等于立即执行操作。

1. 选择操作账户。
2. 开启需要的解析或管理能力。
3. 点击保存更改，刷新页面确认配置已持久化。
4. 首次接入只建议开启解析系列、解析广告组和解析广告。
5. 复制广告、过夜、删除广告组、申诉和无转化关闭应在规则引擎与人工确认完成后再启用。

注意事项：

- 删除广告组属于高风险能力，正式启用前必须增加二次确认和操作上限。

## 6. 阈值配置

阈值用于描述判断条件，当前尚未绑定真实自动执行动作。

1. 在阈值配置选择目标账户。
2. 点击新增阈值，填写唯一配置代码、指标、运算符、数值、单位和阶段。
3. 第一阶段用于早期数据判断，第二阶段用于更高消耗或更成熟数据判断，全局用于预算等通用限制。
4. 保存后可编辑、停用或删除阈值。
5. 修改阈值后应在人工确认模式观察至少一个完整投放周期，再考虑自动模式。

注意事项：

- 账户币种由 TikTok 广告账户决定，多个币种账户不能直接共用同一数值。

## 7. 常见问题

优先根据连接状态和提示定位问题，不要反复提交真实广告操作。

1. Cookie 返回 HTTP 401/403：重新登录、确认 Cookie 来自同一账户，并检查 CSRF Token。
2. Cookie 返回 HTML：复制的是网页地址而不是 Fetch/XHR JSON 请求 URL。
3. 连接超时：确认本机可访问 TikTok，检查代理网络，并重试一次。
4. 提示 fetch failed：本地 API 会自动继承 HTTPS_PROXY/HTTP_PROXY 或 Windows 系统代理；确认 QuickQ、Clash 等代理仍在运行，然后重启本地 API 再检测。
5. API 返回授权错误：核对 advertiser ID、Token 权限和广告主授权状态。
6. 同步数量为 0：检查列表 URL 的分页、筛选参数和响应字段，查看页面中的同步警告。
7. 凭据无法解密：凭据由当前 Windows 用户保护，换电脑或换系统用户后需要重新保存。

## 8. 新功能教程更新规则

本手册是产品功能的一部分，每次新增用户可见功能必须同步更新。

1. 在 packages/manual/guide.json 新增或更新对应章节。
2. 章节必须包含使用前提、具体步骤、风险提示和常见错误。
3. 执行 pnpm docs:generate，更新 docs/USER_GUIDE.md。
4. 增加功能测试，并在浏览器验证手册入口和新功能入口。
5. 代码评审时检查教程是否与当前页面字段和按钮名称一致。

注意事项：

- 不得只更新 Markdown；Web 置顶手册和 Markdown 必须来自同一份 guide.json。

