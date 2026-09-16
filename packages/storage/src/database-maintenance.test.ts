import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile } from "./database-maintenance.js";

/**
 * hashFile 用来校验迁移前的整库备份。
 *
 * 它原来是 `readFileSync(path)` 一次性读完，而 Node 单次读有 2 GiB 硬上限。
 * 2026-09-17 生产机上库涨到 4.13 GB，于是**任何带新迁移的版本都装不上去**：
 * 启动时抛 `ERR_FS_FILE_TOO_LARGE` → 「数据库迁移失败，服务未启动」，
 * 表现为端口不监听、迁移不落库，看着像新版本崩了。
 *
 * 备份文件按定义就是整库大小、只会越来越大，所以必须分块读。这里用一个跨多块的
 * 文件验证分块拼接没写错——块大小是 8 MiB，真造 2 GiB 文件不现实。
 */
describe("hashFile", () => {
  let directory = "";
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = "";
  });

  const write = (bytes: Buffer): string => {
    directory = mkdtempSync(join(tmpdir(), "hash-file-"));
    const path = join(directory, "sample.bin");
    writeFileSync(path, bytes);
    return path;
  };

  it("跨多个读取块的文件，结果与一次性哈希一致", () => {
    // 20 MiB：确保跨过 8 MiB 的块边界，且最后一块是半截的。
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const path = write(bytes);

    expect(hashFile(path)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("空文件返回空内容的哈希，不是空串", () => {
    const path = write(Buffer.alloc(0));
    expect(hashFile(path)).toBe(createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  });

  it("正好落在块边界上的文件也对得上", () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
    const path = write(bytes);
    expect(hashFile(path)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
