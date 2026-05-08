import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { RuntimeClient } from "./runtimeClient";

export function parseListenFromBaseUrl(baseUrl: string): { host: string; port: number } {
  const fallback = { host: "127.0.0.1", port: 7878 };
  try {
    const raw = baseUrl.trim().replace(/\/$/, "");
    if (!raw) return fallback;
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const host = u.hostname || fallback.host;
    let port = u.port ? parseInt(u.port, 10) : fallback.port;
    if (!Number.isFinite(port) || port <= 0) port = fallback.port;
    return { host, port };
  } catch {
    return fallback;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 存在则加入 PATH 前缀，供 where/which 与编辑器进程「缩水的 PATH」配合使用 */
function existingPathHints(): string[] {
  const home = os.homedir();
  if (!home) return [];
  const dirs: string[] = [];
  if (process.platform === "win32") {
    dirs.push(
      path.join(home, ".cargo", "bin"),
      path.join(home, "scoop", "shims")
    );
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  } else {
    dirs.push(
      path.join(home, ".cargo", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(home, ".local", "bin")
    );
  }
  return dirs.filter((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
}

function envWithPrependedPath(extraDirs: string[]): NodeJS.ProcessEnv {
  const base = process.env.Path ?? process.env.PATH ?? "";
  const merged = extraDirs.length
    ? `${extraDirs.join(path.delimiter)}${path.delimiter}${base}`
    : base;
  return { ...process.env, PATH: merged, Path: merged };
}

/** Windows `where` 可能多行；优先真实 deepseek.exe，尽量避免选 .cmd（Node spawn 对批处理易出问题） */
function pickDeepseekFromWhereLines(lines: string[]): string | undefined {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  if (!clean.length) return undefined;
  const exe = clean.find((l) => /[/\\]deepseek\.exe$/i.test(l));
  if (exe) return exe;
  const noWrapper = clean.find((l) => !/\.(cmd|bat|ps1)$/i.test(l));
  if (noWrapper) return noWrapper;
  return clean[0];
}

/**
 * 用系统提供的解析命令在 PATH 上查找 `deepseek`（并临时前缀常见安装目录），得到绝对路径。
 */
function findDeepseekViaSystemLookup(): string | undefined {
  const env = envWithPrependedPath(existingPathHints());
  try {
    if (process.platform === "win32") {
      const out = execFileSync("where.exe", ["deepseek"], {
        encoding: "utf8",
        env,
        windowsHide: true,
      }).trim();
      const picked = pickDeepseekFromWhereLines(out.split(/\r?\n/));
      return picked && fs.existsSync(picked) ? path.normalize(picked) : undefined;
    }
    try {
      const out = execFileSync("which", ["deepseek"], {
        encoding: "utf8",
        env,
        windowsHide: true,
      }).trim();
      const line = out.split("\n")[0]?.trim();
      return line && fs.existsSync(line) ? path.normalize(line) : undefined;
    } catch {
      const out = execFileSync("/bin/sh", ["-c", "command -v deepseek"], {
        encoding: "utf8",
        env,
        windowsHide: true,
      }).trim();
      const line = out.split("\n")[0]?.trim();
      return line && fs.existsSync(line) ? path.normalize(line) : undefined;
    }
  } catch {
    return undefined;
  }
}

function fallbackDeepseekKnownPaths(): string | undefined {
  const home = os.homedir();
  if (!home) return undefined;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const cargoBin = path.join(home, ".cargo", "bin");
    candidates.push(path.join(cargoBin, "deepseek.exe"), path.join(cargoBin, "deepseek"));
    candidates.push(path.join(home, "scoop", "shims", "deepseek.exe"));
  } else {
    candidates.push(path.join(home, ".cargo", "bin", "deepseek"));
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * 配置为默认名 `deepseek` 时：先用系统 PATH 查找（where / which），失败再试常见安装路径，最后回退为命令名。
 */
export function resolveSpawnExecutable(configured: string): string {
  const name = configured.trim() || "deepseek";
  if (path.isAbsolute(name)) {
    return name;
  }
  const base = path.basename(name);
  if (base.toLowerCase() !== "deepseek" || name !== base) {
    return name;
  }

  const viaLookup = findDeepseekViaSystemLookup();
  if (viaLookup) return viaLookup;

  const viaKnown = fallbackDeepseekKnownPaths();
  if (viaKnown) return viaKnown;

  return name;
}

function readRuntimeSpawnOptions(): {
  executable: string;
  /** 设置里的原始值（未解析），用于日志 */
  executableConfigured: string;
  host: string;
  port: number;
  authToken: string | undefined;
} {
  const cfg = vscode.workspace.getConfiguration("deepseek.runtime");
  const baseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:7878";
  const authRaw = cfg.get<string>("authToken")?.trim();
  const executableConfigured = (cfg.get<string>("executable") ?? "deepseek").trim() || "deepseek";
  const executable = resolveSpawnExecutable(executableConfigured);
  const { host, port } = parseListenFromBaseUrl(baseUrl);
  return { executable, executableConfigured, host, port, authToken: authRaw || undefined };
}

function autoStartEnabled(): boolean {
  return vscode.workspace.getConfiguration("deepseek.runtime").get<boolean>("autoStartRuntime", true);
}

/** deepseek-tui 仅作子进程提示；若误用 TUI 本体而非调度器会触发 */
function hintIfWrongExecutable(stderr: string): string | undefined {
  const s = stderr;
  if (/Usage:\s*deepseek-tui\b|deepseek-tui(\.exe)?\b/i.test(s)) {
    return "（提示）请确认 deepseek.runtime.executable 指向调度器 deepseek（与 deepseek-tui 成对安装），勿单独使用 deepseek-tui 可执行文件。";
  }
  return undefined;
}

/**
 * Optionally spawns and owns `deepseek serve --http` for the current workspace.
 * If /health already responds, never spawns (avoids killing a user-managed server).
 */
export class ManagedDeepseekRuntime implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private stderrTail = "";
  private readonly output: vscode.OutputChannel;
  private startChain: Promise<boolean> | undefined;

  constructor(
    private readonly client: RuntimeClient,
    outputChannelId = "DeepSeek Runtime"
  ) {
    this.output = vscode.window.createOutputChannel(outputChannelId);
  }

  get isManagingProcess(): boolean {
    return this.child !== undefined && !this.child.killed;
  }

  showOutput(): void {
    this.output.show(true);
  }

  private killManagedChild(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  dispose(): void {
    this.killManagedChild();
    this.output.dispose();
  }

  private appendStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    this.output.append(chunk);
  }

  /**
   * Kill only the process spawned by this extension (if any).
   */
  stopManaged(): void {
    this.killManagedChild();
  }

  /**
   * 调度器 `deepseek`（deepseek-tui-cli）的 Clap 无全局 `--workspace`；工作区由子进程 cwd 决定，
   * 与在终端 `cd <项目> && deepseek serve --http` 一致（deepseek-tui 内用 current_dir 解析 workspace）。
   */
  private buildArgs(): string[] {
    const { host, port, authToken } = readRuntimeSpawnOptions();
    const args = ["serve", "--http", "--host", host, "--port", String(port)];
    if (authToken) {
      args.push("--auth-token", authToken);
    }
    return args;
  }

  private async waitForHealthy(
    child: ChildProcess,
    timeoutMs: number,
    stepMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.client.health()) {
        return true;
      }
      if (child.killed || child.exitCode !== null) {
        return false;
      }
      await sleep(stepMs);
    }
    return this.client.health();
  }

  /**
   * Spawns `deepseek serve --http` and waits for /health. Caller must ensure health is false first.
   */
  private async spawnAndWaitHealthy(workspacePath: string): Promise<boolean> {
    const { executable, executableConfigured, host, port } = readRuntimeSpawnOptions();
    const args = this.buildArgs();

    this.stderrTail = "";
    if (executable !== executableConfigured) {
      this.output.appendLine(
        `[spawn] 可执行文件（设置中为「${executableConfigured}」）已解析为: ${executable}`
      );
    }
    this.output.appendLine(
      `[spawn] ${executable} ${args.join(" ")}  (cwd=${workspacePath})`
    );

    const env = { ...process.env };
    const stdio: StdioOptions = ["ignore", "pipe", "pipe"];

    const child = spawn(executable, args, {
      cwd: workspacePath,
      env,
      windowsHide: true,
      stdio,
    });
    this.child = child;

    child.stdout?.on("data", (d: Buffer) => this.output.append(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.appendStderr(d.toString()));
    child.on("error", (err: Error) => {
      this.appendStderr(`\n[spawn error] ${err.message}\n`);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.output.appendLine(`[exit] code=${code ?? "?"} signal=${signal ?? ""}`);
        this.child = undefined;
      }
    });

    const ok = await this.waitForHealthy(child, 25_000, 400);
    if (!ok) {
      const hint = this.stderrTail.trim().slice(-800) || "(无 stderr)";
      const wrongExe = hintIfWrongExecutable(this.stderrTail);
      void vscode.window.showErrorMessage(
        `DeepSeek 运行时在 ${host}:${port} 未就绪。详情见输出面板「DeepSeek Runtime」。最后日志: ${hint.replace(/\s+/g, " ").slice(0, 200)}${wrongExe ?? ""}`
      );
      if (wrongExe) {
        this.output.appendLine(wrongExe);
      }
      this.showOutput();
      if (this.child === child && !child.killed) {
        child.kill();
        this.child = undefined;
      }
      return false;
    }

    this.output.appendLine(`[ready] http://${host}:${port}/health`);
    return true;
  }

  /**
   * When autoStartRuntime is on: ensure /health responds, spawning if needed.
   * When off: does not spawn; returns whether /health is OK.
   */
  async ensureRunning(workspacePath: string | undefined): Promise<boolean> {
    if (this.startChain) {
      return this.startChain;
    }
    this.startChain = this.doEnsureRunning(workspacePath).finally(() => {
      this.startChain = undefined;
    });
    return this.startChain;
  }

  private async doEnsureRunning(workspacePath: string | undefined): Promise<boolean> {
    if (!autoStartEnabled()) {
      return this.client.health();
    }
    if (!workspacePath) {
      void vscode.window.showWarningMessage(
        "DeepSeek：未打开工作区文件夹，已跳过自动启动。请先打开项目文件夹，或在设置中填写 deepseek.runtime.workspace。"
      );
      return false;
    }
    if (await this.client.health()) {
      return true;
    }
    this.stopManaged();
    await sleep(200);
    return this.spawnAndWaitHealthy(workspacePath);
  }

  /**
   * Stops a managed process (if any) and starts a new one when /health is down.
   * Ignores autoStartRuntime so the command always attempts recovery when possible.
   */
  async restart(workspacePath: string | undefined): Promise<boolean> {
    this.stopManaged();
    await sleep(500);
    if (!workspacePath) {
      void vscode.window.showWarningMessage("DeepSeek：未打开工作区文件夹，无法重启运行时。");
      return false;
    }
    if (await this.client.health()) {
      void vscode.window.showInformationMessage(
        "DeepSeek：/health 已有响应。若会话列表来自其他窗口的运行时，请调整 deepseek.runtime.baseUrl 或关闭多余的 deepseek serve。"
      );
      return true;
    }
    return this.spawnAndWaitHealthy(workspacePath);
  }
}
