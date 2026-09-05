import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationStore } from "@tk-auto/storage";
import { AuthService } from "./auth-service.js";
import { MCP_AGENT_USERNAME, ensureMcpEndpoint, type McpEndpointFile } from "./mcp-access.js";

describe("MCP 接入点", () => {
  let store: AutomationStore;
  let auth: AuthService;
  let directory: string;
  let filePath: string;
  const origin = "http://127.0.0.1:31373";

  beforeEach(() => {
    store = new AutomationStore(":memory:");
    store.seed();
    auth = new AuthService(store);
    directory = mkdtempSync(join(tmpdir(), "tk-mcp-"));
    filePath = join(directory, "nested", "mcp-endpoint.json");
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const read = (): McpEndpointFile =>
    JSON.parse(readFileSync(filePath, "utf8")) as McpEndpointFile;

  it("首次启动就建好身份并写下可用的令牌", async () => {
    const endpoint = await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });

    expect(endpoint).not.toBeNull();
    expect(read()).toMatchObject({ origin, token: endpoint?.token });
    const session = auth.authenticate(endpoint?.token ?? "");
    expect(session?.user.username).toBe(MCP_AGENT_USERNAME);
    // operator：够用来读账户、生成表、扩组复制，但改不了系统设置也管不了本机账户。
    expect(session?.user.role).toBe("operator");
    expect(session?.permissions).not.toContain("system:control");
    expect(session?.permissions).not.toContain("users:manage");
  });

  it("令牌还有效时原样保留，不每次启动都换一张", async () => {
    // 后台程序会因为升级、崩溃恢复、用户重启反复启动。每次换令牌会让正连着的 MCP
    // 会话在下一次调用时突然 401，而 agent 那侧只看得到一句没头没尾的「未登录」。
    const first = await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });
    const second = await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });

    expect(second?.token).toBe(first?.token);
    expect(second?.issuedAt).toBe(first?.issuedAt);
  });

  it("换了监听地址就重新签发", async () => {
    const first = await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });
    const moved = await ensureMcpEndpoint({
      auth,
      origin: "http://127.0.0.1:3100",
      endpointFilePath: filePath,
    });

    expect(moved?.origin).toBe("http://127.0.0.1:3100");
    expect(moved?.token).not.toBe(first?.token);
  });

  it("文件被改坏时重新签发，而不是就此瘫掉", async () => {
    await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });
    writeFileSync(filePath, "{ 这不是 JSON", "utf8");

    const reissued = await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });

    expect(reissued).not.toBeNull();
    expect(auth.authenticate(reissued?.token ?? "")?.user.username).toBe(MCP_AGENT_USERNAME);
  });

  it("身份被停用时不签发，并把原因报出来", async () => {
    // 停用是一个明确的人为决定，不能被下一次开机悄悄推翻。
    await ensureMcpEndpoint({ auth, origin, endpointFilePath: filePath });
    const agent = store.getStoredLocalUserByUsername(MCP_AGENT_USERNAME);
    store.updateLocalUser(agent?.id ?? "", {
      displayName: "MCP 助手",
      role: "operator",
      enabled: false,
    });
    rmSync(filePath);
    let reported: unknown = null;

    const result = await ensureMcpEndpoint({
      auth,
      origin,
      endpointFilePath: filePath,
      onError: (cause) => { reported = cause; },
    });

    expect(result).toBeNull();
    expect((reported as Error).message).toContain("已被停用");
  });
});
