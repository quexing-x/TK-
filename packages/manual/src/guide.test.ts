import { describe, expect, it } from "vitest";
import { userGuide } from "./index.js";

describe("user guide", () => {
  it("contains both provider tutorials and the update policy", () => {
    expect(userGuide.version).toBe("1.4.132");
    const ids = userGuide.sections.map((section) => section.id);
    expect(ids).toContain("cookie-provider");
    expect(ids).toContain("official-api-provider");
    expect(ids).toContain("automation-center");
    expect(ids).toContain("ad-management");
    expect(ids).toContain("analytics");
    expect(ids).toContain("notifications");
    expect(ids).toContain("agent-mcp");
    expect(ids).toContain("development-policy");

    const mcpGuide = userGuide.sections.find((section) => section.id === "agent-mcp");
    expect(mcpGuide?.steps.join(" ")).toContain("mcp-endpoint.json");
    expect(mcpGuide?.steps.join(" ")).toContain("ELECTRON_RUN_AS_NODE");
    // 令牌等同于一个能操作广告账户的登录态，「不要外发」这句必须在手册里说死。
    expect(mcpGuide?.notes.join(" ")).toContain("不要发到群里");
    // 每个支持的宿主都得有独立的一节：漏掉一个，用户就只能自己猜配置怎么写。
    const mcpText = [...(mcpGuide?.steps ?? []), ...(mcpGuide?.notes ?? [])].join(" ");
    for (const client of ["Codex", "DSH", "WorkBuddy", "豆包工作"]) {
      expect(mcpText).toContain(client);
    }
    // stdio 宿主各写各的配置文件，这几个路径写错了就接不上。
    expect(mcpText).toContain("cordis.patch.yml");
    expect(mcpText).toContain("mcpServers");
    // 豆包工作填不了命令行，只能走 HTTP 端点；端点文件和端口必须交代清楚。
    expect(mcpText).toContain("mcp-http.cjs");
    expect(mcpText).toContain("31374");
    // HTTP 端点把写能力暴露到了网络接口上，只监听回环这句是安全承诺，不能省。
    expect(mcpText).toContain("127.0.0.1");
    // 无界面模式下 WorkBuddy 不审批项目级 MCP，必须靠这个开关放行。
    expect(mcpText).toContain("enabledMcpjsonServers");

    const notificationGuide = userGuide.sections.find(
      (section) => section.id === "notifications",
    );
    expect(notificationGuide?.steps.join(" ")).toContain("没有到期账户");
    expect(notificationGuide?.notes.join(" ")).toContain("DPAPI");
    expect(notificationGuide?.links).toHaveLength(3);

    const cookieGuide = userGuide.sections.find(
      (section) => section.id === "cookie-provider",
    );
    expect(cookieGuide?.steps.join(" ")).toContain("Copy as cURL (bash)");
    expect(cookieGuide?.steps.join(" ")).toContain("/adgroup/list/?");
    expect(cookieGuide?.steps.join(" ")).toContain("/ad/update_status/?");
    expect(cookieGuide?.steps.join(" ")).toContain("左侧“广告组列表 cURL”输入框");
    expect(cookieGuide?.steps.join(" ")).toContain("右侧“广告启停 cURL”输入框");
    expect(cookieGuide?.steps.join(" ")).toContain("导入并检查");
    expect(cookieGuide?.steps.join(" ")).toContain("五个必要字段");
    expect(cookieGuide?.notes.join(" ")).toContain("用户不需要再复制第三条请求");
    expect(cookieGuide?.notes.join(" ")).toContain("Windows DPAPI 加密");

    const quickStart = userGuide.sections.find(
      (section) => section.id === "quick-start",
    );
    expect(quickStart?.steps.join(" ")).toContain("更高版本安装包");
    expect(quickStart?.notes.join(" ")).toContain("文档\\TK Ads Automation");
  });
});
