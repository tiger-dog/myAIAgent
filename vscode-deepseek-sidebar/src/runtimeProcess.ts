import { spawn, type ChildProcess } from "child_process";
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

function readRuntimeSpawnOptions(): {
  executable: string;
  host: string;
  port: number;
  authToken: string | undefined;
} {
  const cfg = vscode.workspace.getConfiguration("deepseek.runtime");
  const baseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:7878";
  const authRaw = cfg.get<string>("authToken")?.trim();
  const executable = (cfg.get<string>("executable") ?? "deepseek").trim() || "deepseek";
  const { host, port } = parseListenFromBaseUrl(baseUrl);
  return { executable, host, port, authToken: authRaw || undefined };
}

function autoStartEnabled(): boolean {
  return vscode.workspace.getConfiguration("deepseek.runtime").get<boolean>("autoStartRuntime", true);
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

  private buildArgs(workspacePath: string): string[] {
    const { host, port, authToken } = readRuntimeSpawnOptions();
    const args = [
      "--workspace",
      workspacePath,
      "serve",
      "--http",
      "--host",
      host,
      "--port",
      String(port),
    ];
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
    const { executable, host, port } = readRuntimeSpawnOptions();
    const args = this.buildArgs(workspacePath);

    this.stderrTail = "";
    this.output.appendLine(`[spawn] ${executable} ${args.join(" ")}`);

    const child = spawn(executable, args, {
      cwd: workspacePath,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      void vscode.window.showErrorMessage(
        `DeepSeek 运行时在 ${host}:${port} 未就绪。详情见输出面板「DeepSeek Runtime」。最后日志: ${hint.replace(/\s+/g, " ").slice(0, 200)}`
      );
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
