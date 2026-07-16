import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CredentialVault {
  create(secret: string): Promise<string>;
  read(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export class WindowsDpapiCredentialVault implements CredentialVault {
  constructor(private readonly directory: string) {}

  async create(secret: string): Promise<string> {
    if (process.platform !== "win32") {
      throw new Error("当前凭据库只支持 Windows DPAPI。");
    }

    await mkdir(this.directory, { recursive: true });
    const reference = randomUUID();
    const plaintextBase64 = Buffer.from(secret, "utf8").toString("base64");
    const encrypted = await runPowerShell(PROTECT_SCRIPT, plaintextBase64);
    await writeFile(this.pathFor(reference), encrypted, {
      encoding: "utf8",
      mode: 0o600,
    });
    return reference;
  }

  async read(reference: string): Promise<string | null> {
    assertReference(reference);
    let encrypted: string;
    try {
      encrypted = await readFile(this.pathFor(reference), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const plaintextBase64 = await runPowerShell(
      UNPROTECT_SCRIPT,
      encrypted.trim(),
    );
    return Buffer.from(plaintextBase64.trim(), "base64").toString("utf8");
  }

  async delete(reference: string): Promise<void> {
    assertReference(reference);
    await rm(this.pathFor(reference), { force: true });
  }

  private pathFor(reference: string): string {
    return join(this.directory, `${reference}.dpapi`);
  }
}

export class InMemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<string, string>();

  async create(secret: string): Promise<string> {
    const reference = randomUUID();
    this.values.set(reference, secret);
    return reference;
  }

  async read(reference: string): Promise<string | null> {
    return this.values.get(reference) ?? null;
  }

  async delete(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

const PROTECT_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputText)
$encrypted = [Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))
`;

const UNPROTECT_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$encrypted = [Convert]::FromBase64String($inputText)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

function runPowerShell(script: string, input: string): Promise<string> {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", () => reject(new Error("无法启动 Windows DPAPI 凭据保护。")));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("Windows DPAPI 凭据处理失败。"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input, "utf8");
  });
}

function assertReference(reference: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(reference)) {
    throw new Error("无效的凭据引用。");
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
