/**
 * dsh-windows-control — fast path sidecar (host half helper).
 *
 * Why this exists
 * ---------------
 * The bridge's tools are correct but the wrong shape for driving a real
 * application window (a game, a launcher dialog, any SDL/OpenGL surface):
 *
 *   measured on this machine, 2026-11-08, Windows 11 + windows-mcp 0.8.8
 *     mcp__windows__Snapshot   (whole-desktop UIA walk)   26 060 ms
 *     mcp__windows__Screenshot (whole screen, 0.75 scale)    230-790 ms
 *     mcp__windows__Click      (focus + SendInput + flash)   570 ms
 *     mcp__windows__ControlStatus                           10-20 ms, but a
 *       `USER_CONTROL` answer refuses every desktop call for up to 10 s
 *
 * ...and three capability holes that cost whole model steps each:
 *   - no window rect in the same coordinate space Click consumes (a DPI-
 *     unaware GetWindowRect reports 806x629 for a 406x529 window),
 *   - no launch/start primitive at all (`App` is excluded by default and
 *     `Process` can only list and kill),
 *   - no cheap "did it work" predicate, so every verification is another
 *     screenshot plus another model round trip.
 *
 * This module owns a long-lived PowerShell child that answers exactly those
 * questions in 20-120 ms with DPI-correct physical coordinates. It is a
 * sidecar, not a replacement: pixels still come from `mcp__windows__Screenshot`
 * (that path is fast and already attaches images), geometry and input come from
 * here.
 *
 * Zero runtime dependencies beyond `node:*`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const FASTPATH_HOST_PATH = join(packageRoot, "tools", "fastpath-host.ps1");

/** Ops the host understands; kept in one place so the tool schema cannot drift. */
export const FASTPATH_OPS = [
  "ping",
  "windows",
  "rect",
  "focus",
  "launch",
  "click",
  "move",
  "key",
  "type",
  "pixel",
  "wait",
  "kill",
];

/** PowerShell that can run the host: pwsh (7+) first, then Windows PowerShell. */
function candidateShells() {
  const list = [];
  const fromEnv = String(process.env.DSH_WINDOWS_MCP_PWSH ?? "").trim();
  if (fromEnv !== "") list.push(fromEnv);
  list.push("pwsh.exe", "pwsh", "powershell.exe");
  return list;
}

/**
 * A serialized JSON-lines channel to `tools/fastpath-host.ps1`.
 *
 * One request is in flight at a time on purpose: SendInput and window
 * activation are not reentrant, and serializing them keeps click ordering
 * deterministic when a model fires several ops in one step.
 */
export class FastPath {
  /** @param {{ timeoutMs?: number, shell?: string, hostPath?: string, logger?: (line: string) => void }} options */
  constructor(options = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 30000;
    this.hostPath = options.hostPath ?? FASTPATH_HOST_PATH;
    this.shellPreference = options.shell ?? null;
    this.logger = typeof options.logger === "function" ? options.logger : null;
    this.child = null;
    this.shell = null;
    this.buffer = "";
    this.pending = null;
    this.seq = 0;
    this.queue = Promise.resolve();
    this.lastError = null;
    this.ready = false;
    this.spawnMs = null;
    /** @type {{ op: string, ms: number }[]} */
    this.timings = [];
  }

  log(message) {
    if (this.logger) this.logger(message);
  }

  available() {
    return existsSync(this.hostPath);
  }

  /** Start the child (idempotent). Resolves once it answers `ping`. */
  async start() {
    if (this.ready && this.child && this.child.exitCode === null) return this;
    if (!this.available()) throw new Error(`fastpath host missing: ${this.hostPath}`);
    const started = Date.now();
    const shells = this.shellPreference ? [this.shellPreference] : candidateShells();
    let lastError = null;
    for (const shell of shells) {
      try {
        const child = spawn(shell, ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.hostPath], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        await new Promise((resolve, reject) => {
          let settled = false;
          const fail = (error) => {
            if (settled) return;
            settled = true;
            try {
              child.kill();
            } catch {
              /* already gone */
            }
            reject(error);
          };
          child.once("error", fail);
          child.once("spawn", () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          setTimeout(() => fail(new Error(`spawn timeout: ${shell}`)), 8000).unref?.();
        });
        this.child = child;
        this.shell = shell;
        this.buffer = "";
        this.bindChild(child);
        await this.exchange({ op: "ping" }, 20000);
        this.ready = true;
        this.spawnMs = Date.now() - started;
        this.lastError = null;
        return this;
      } catch (error) {
        lastError = error;
      }
    }
    this.ready = false;
    this.lastError = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`fastpath host did not start: ${this.lastError}`);
  }

  bindChild(child) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text !== "") this.log(`fastpath stderr: ${text.slice(0, 400)}`);
    });
    child.on("exit", (code) => {
      this.ready = false;
      if (this.pending) {
        const { reject, timer } = this.pending;
        clearTimeout(timer);
        this.pending = null;
        reject(new Error(`fastpath host exited (code ${code})`));
      }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== "" && this.pending) {
        const { resolve, reject, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        try {
          const payload = JSON.parse(line);
          if (payload?.result?.ok === false) {
            const error = new Error(String(payload.result.error ?? "fastpath op failed"));
            error.result = payload.result;
            reject(error);
          } else {
            resolve({ result: payload?.result ?? null, ms: Number(payload?.ms ?? 0) });
          }
        } catch (error) {
          reject(new Error(`fastpath protocol error: ${String(error)} line=${line.slice(0, 200)}`));
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  exchange(request, timeoutMs) {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error("fastpath host is not running"));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) this.pending = null;
        reject(new Error(`fastpath op timed out after ${timeoutMs} ms: ${request.op}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending = { resolve, reject, timer };
      try {
        this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        reject(error);
      }
    });
  }

  /**
   * Run one op. Serialized against every other op on this sidecar.
   * @param {string} op
   * @param {Record<string, unknown>} args
   * @param {number} [timeoutMs]
   */
  async request(op, args = {}, timeoutMs = this.timeoutMs) {
    const run = async () => {
      await this.start();
      const { result, ms } = await this.exchange({ op, ...args }, timeoutMs);
      this.timings.push({ op, ms });
      if (this.timings.length > 64) this.timings.shift();
      return { ...result, ms };
    };
    const next = this.queue.then(run, run);
    // Keep the chain alive even when this request rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  dispose() {
    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      /* best effort */
    }
    this.child = null;
    this.ready = false;
  }
}

/** Create the shared sidecar for one plugin instance. */
export function createFastPath(options = {}) {
  return new FastPath(options);
}
