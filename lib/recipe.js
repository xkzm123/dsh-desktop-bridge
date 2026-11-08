/**
 * dsh-windows-control — recipe engine (L2-a).
 *
 * The measured problem this solves is not per-op latency, it is the number of
 * model round trips: driving Kingdom Rush Origins to the first battle took 18
 * tool calls and 230 s of model time, while the actual desktop work was ~6 s.
 * A recipe collapses that into ONE call: the model describes the sequence once,
 * the host executes it at local speed and returns a per-step timing table.
 *
 * Every step maps onto one fastpath op (see `tools/fastpath-host.ps1`), so the
 * engine stays a thin, testable sequencer with no Win32 knowledge of its own.
 *
 * Step shapes — both forms are accepted:
 *   { "op": "click", "at": [440, 724] }
 *   { "click": { "at": [440, 724] } }          # nicer in YAML
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Ops the engine understands. Anything else fails validation before any side effect. */
export const RECIPE_OPS = [
  "launch",
  "wait_window",
  "focus",
  "rect",
  "click",
  "click_until",
  "move",
  "key",
  "type",
  "pixel",
  "wait_pixel",
  "wait_idle",
  "assert",
  "sleep",
];

const DEFAULT_STEP_TIMEOUT_MS = 15000;

/**
 * Normalize one step into `{ op, args }`.
 * @returns {{ op: string, args: Record<string, unknown> }}
 */
export function normalizeStep(step, index) {
  if (step === null || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`step ${index}: expected an object, got ${Array.isArray(step) ? "array" : typeof step}`);
  }
  if (typeof step.op === "string") {
    const { op, ...args } = step;
    return { op, args };
  }
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    throw new Error(`step ${index}: either "op" or exactly one op-named key is required, got [${keys.join(", ")}]`);
  }
  const [op] = keys;
  const value = step[op];
  const args = value === null || value === undefined ? {} : value;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`step ${index}: "${op}" must be an object of arguments`);
  }
  return { op, args };
}

/**
 * Validate a whole recipe without touching the desktop.
 * @returns {{ ok: boolean, error?: string, steps: { op: string, args: Record<string, unknown> }[] }}
 */
export function validateRecipe(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, error: "a recipe needs a non-empty array of steps", steps: [] };
  }
  const normalized = [];
  for (let index = 0; index < steps.length; index += 1) {
    try {
      const step = normalizeStep(steps[index], index);
      if (!RECIPE_OPS.includes(step.op)) {
        return { ok: false, error: `step ${index}: unknown op "${step.op}" (known: ${RECIPE_OPS.join(", ")})`, steps: [] };
      }
      if (step.op === "click" || step.op === "move") {
        const at = step.args.at;
        if (!Array.isArray(at) || at.length !== 2 || !Number.isFinite(Number(at[0])) || !Number.isFinite(Number(at[1]))) {
          return { ok: false, error: `step ${index}: ${step.op} needs "at": [x, y]`, steps: [] };
        }
      }
      if (step.op === "launch" && typeof step.args.path !== "string") {
        return { ok: false, error: `step ${index}: launch needs "path"`, steps: [] };
      }
      if ((step.op === "wait_window" || step.op === "focus" || step.op === "rect") && typeof step.args.title !== "string" && step.args.hwnd === undefined) {
        return { ok: false, error: `step ${index}: ${step.op} needs "title" or "hwnd"`, steps: [] };
      }
      normalized.push(step);
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error), steps: [] };
    }
  }
  return { ok: true, steps: normalized };
}

function sameHex(a, b) {
  return String(a ?? "").toUpperCase() === String(b ?? "").toUpperCase();
}

/**
 * Run a validated recipe.
 *
 * @param {{ op: string, args: Record<string, unknown> }[]} steps
 * @param {{ fast: { request: (op: string, args?: object, timeoutMs?: number) => Promise<any> }, logger?: (line: string) => void, defaultTimeoutMs?: number, resolution?: [number, number] }} options
 */
export async function runRecipe(steps, options) {
  const fast = options?.fast;
  if (!fast || typeof fast.request !== "function") throw new Error("runRecipe needs a fastpath executor");
  const log = typeof options.logger === "function" ? options.logger : () => {};
  const defaultTimeoutMs = Number.isFinite(options?.defaultTimeoutMs) ? Number(options.defaultTimeoutMs) : DEFAULT_STEP_TIMEOUT_MS;

  const startedAt = Date.now();
  /** @type {any} */
  const context = { window: null, pixels: {} };
  const report = [];

  for (let index = 0; index < steps.length; index += 1) {
    // Accept both shapes here as well: a caller that skips validateRecipe must
    // not get a TypeError instead of a useful step error.
    const raw = steps[index];
    const { op, args } = raw !== null && typeof raw === "object" && typeof raw.op === "string" ? { op: raw.op, args: raw } : normalizeStep(raw, index);
    const stepStart = Date.now();
    const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : defaultTimeoutMs;
    const attempts = Math.max(1, Math.min(5, Number(args.retries ?? 1)));
    const retryDelayMs = Math.max(0, Math.min(5000, Number(args.retryDelayMs ?? 250)));
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const detail = await runStep(op, args, { fast, context, timeoutMs, defaultTimeoutMs, log });
        report.push({ index, op, ms: Date.now() - stepStart, ok: true, attempts: attempt, detail: detail ?? null });
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    if (lastError === null) continue;
    {
      const message = lastError.message;
      report.push({ index, op, ms: Date.now() - stepStart, ok: false, attempts, error: message });
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        failedAt: index,
        error: message,
        steps: report,
        window: context.window,
      };
    }
  }

  return { ok: true, elapsedMs: Date.now() - startedAt, steps: report, window: context.window };
}

async function runStep(op, args, env) {
  const { fast, context, timeoutMs } = env;
  const at = Array.isArray(args.at) ? [Number(args.at[0]), Number(args.at[1])] : null;

  switch (op) {
    case "launch": {
      const result = await fast.request(
        "launch",
        { path: args.path, args: args.args ?? null, title: args.title ?? "", waitMs: timeoutMs },
        timeoutMs + 2000,
      );
      if (result?.window) context.window = result.window;
      return { pid: result?.pid ?? null, window: result?.window ?? null, appearedMs: result?.elapsedMs ?? null };
    }
    case "wait_window": {
      const sized = Number.isFinite(Number(args.minWidth)) || Number.isFinite(Number(args.minHeight));
      const result = await fast.request(
        "wait",
        {
          mode: sized ? "window_size" : "window",
          title: args.title,
          minWidth: args.minWidth,
          minHeight: args.minHeight,
          stableMs: args.stableMs,
          timeoutMs,
        },
        timeoutMs + 2000,
      );
      if (result?.window) context.window = result.window;
      return { window: result?.window ?? null, waitedMs: result?.elapsedMs ?? null };
    }
    case "focus": {
      const result = await fast.request("focus", { hwnd: args.hwnd, title: args.title }, timeoutMs);
      if (result?.window) context.window = result.window;
      return { window: result?.window ?? null };
    }
    case "rect": {
      const result = await fast.request("rect", { hwnd: args.hwnd, title: args.title }, timeoutMs);
      if (result?.window) context.window = result.window;
      return { window: result?.window ?? null };
    }
    case "click":
    case "move":
      return await clickOnce(fast, op, args, context, timeoutMs);
    case "click_until": {
      // Launcher dance: click, then require the window to actually change size.
      // A freshly created launcher ignores the first click for a few hundred ms,
      // so a fire-and-forget click is a coin flip; this is a retried click plus
      // an assertion that the transition really happened.
      const attempts = Math.max(1, Math.min(6, Number(args.retries ?? 3)));
      const perTry = Math.max(800, Number(args.timeoutMs ?? 6000));
      const until = args.until ?? (args.minWidth ? { minWidth: args.minWidth, minHeight: args.minHeight } : null);
      if (!until) throw new Error('click_until needs "until" (a window size or a pixel predicate)');
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await clickOnce(fast, "click", args, context, timeoutMs);
        try {
          const hit = await waitUntil(fast, until, perTry, context);
          if (hit) return { attempts: attempt, waitedMs: hit.elapsedMs ?? null, until: hit };
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(
        `click_until: predicate never satisfied after ${attempts} clicks (${JSON.stringify(until)})${lastError ? ` — ${lastError.message}` : ""}`,
      );
    }
    case "key": {
      if (typeof args.combo !== "string" || args.combo === "") throw new Error("key needs \"combo\"");
      return await fast.request("key", { combo: args.combo }, timeoutMs);
    }
    case "type": {
      if (typeof args.text !== "string") throw new Error("type needs \"text\"");
      return await fast.request("type", { text: args.text }, timeoutMs);
    }
    case "pixel": {
      const result = await fast.request("pixel", { x: at[0], y: at[1] }, timeoutMs);
      context.pixels[`${at[0]},${at[1]}`] = result?.hex ?? null;
      return { hex: result?.hex ?? null };
    }
    case "wait_pixel": {
      const result = await fast.request(
        "wait",
        { mode: "pixel", x: at[0], y: at[1], hex: args.hex, timeoutMs },
        timeoutMs + 2000,
      );
      return { hex: result?.hex ?? null, waitedMs: result?.elapsedMs ?? null };
    }
    case "wait_idle": {
      const region = Array.isArray(args.region) ? args.region.map(Number) : null;
      if (!region || region.length !== 4) throw new Error("wait_idle needs \"region\": [x, y, w, h]");
      const result = await fast.request(
        "wait",
        { mode: "idle", x: region[0], y: region[1], w: region[2], h: region[3], timeoutMs },
        timeoutMs + 2000,
      );
      return { waitedMs: result?.elapsedMs ?? null };
    }
    case "assert": {
      const checks = [];
      if (Array.isArray(args.window)) {
        const wanted = String(args.window[0] ?? "");
        const actual = context.window?.title ?? "";
        checks.push({ kind: "window", expected: wanted, actual, pass: actual.includes(wanted) });
      }
      if (Number.isFinite(Number(args.minWidth)) || Number.isFinite(Number(args.minHeight))) {
        const wantW = Number(args.minWidth ?? 0);
        const wantH = Number(args.minHeight ?? 0);
        const haveW = Number(context.window?.w ?? 0);
        const haveH = Number(context.window?.h ?? 0);
        checks.push({ kind: "window-size", expected: `>=${wantW}x${wantH}`, actual: `${haveW}x${haveH}`, pass: haveW >= wantW && haveH >= wantH });
      }
      if (Array.isArray(args.pixel)) {
        const px = Number(args.pixel[0]);
        const py = Number(args.pixel[1]);
        const result = await fast.request("pixel", { x: px, y: py }, timeoutMs);
        const hex = result?.hex ?? null;
        if (typeof args.hex === "string") {
          checks.push({ kind: "pixel", at: [px, py], expected: args.hex, actual: hex, pass: sameHex(hex, args.hex) });
        }
        if (typeof args.not === "string") {
          checks.push({ kind: "pixel-not", at: [px, py], expected: args.not, actual: hex, pass: !sameHex(hex, args.not) });
        }
        context.pixels[`${px},${py}`] = hex;
      }
      const failed = checks.filter((check) => !check.pass);
      if (failed.length > 0) {
        throw new Error(`assert failed: ${failed.map((c) => `${c.kind} expected ${c.expected} got ${c.actual}`).join("; ")}`);
      }
      return { checks };
    }
    case "sleep": {
      const ms = Math.max(0, Math.min(60000, Number(args.ms ?? 250)));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { sleptMs: ms };
    }
    default:
      throw new Error(`unsupported op "${op}"`);
  }
}

/**
 * Poll one predicate until it holds.
 *
 * Two shapes are supported, and they cover every menu transition seen so far:
 *   { minWidth, minHeight, stableMs }        a window that grew/replaced itself
 *   { pixel: [x, y], hex } / { not: "#hex" }  a UI region that repainted
 */
async function waitUntil(fast, until, timeoutMs, context) {
  if (Number.isFinite(Number(until?.minWidth)) || Number.isFinite(Number(until?.minHeight))) {
    const title = typeof until.title === "string" ? until.title : context.window?.title;
    const waited = await fast.request(
      "wait",
      {
        mode: "window_size",
        title,
        minWidth: Number(until.minWidth ?? 0),
        minHeight: Number(until.minHeight ?? 0),
        stableMs: until.stableMs ?? 600,
        timeoutMs,
      },
      timeoutMs + 2000,
    );
    if (waited?.window) context.window = waited.window;
    return waited?.window ? waited : null;
  }
  if (Array.isArray(until?.pixel)) {
    const x = Number(until.pixel[0]);
    const y = Number(until.pixel[1]);
    const want = typeof until.hex === "string" ? until.hex : null;
    const not = typeof until.not === "string" ? until.not : null;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const probe = await fast.request("pixel", { x, y }, 2000);
      last = probe?.hex ?? null;
      const match = want ? sameHex(last, want) : not ? !sameHex(last, not) : true;
      if (match) return { pixel: [x, y], hex: last, elapsedMs: timeoutMs - (deadline - Date.now()) };
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(`pixel ${x},${y} stayed ${last}`);
  }
  throw new Error("unsupported until predicate");
}

/**
 * Resolve and send one click/move. A title always wins over a cached hwnd: the
 * window a launcher replaces during startup must be resolved fresh per attempt.
 */
async function clickOnce(fast, op, args, context, timeoutMs) {
  const at = Array.isArray(args.at) ? [Number(args.at[0]), Number(args.at[1])] : null;
  if (!at) throw new Error(`${op} needs "at": [x, y]`);
  let x = at[0];
  let y = at[1];
  const targetTitle = typeof args.window === "string" ? args.window : null;
  if (args.relative === true) {
    if (!context.window) throw new Error(`${op}: relative coordinates need a known window (launch/wait_window/rect first)`);
    x += context.window.x;
    y += context.window.y;
  }
  const payload = { x, y };
  if (op === "click") {
    payload.button = args.button ?? "left";
    payload.clicks = args.clicks ?? 1;
  }
  const hwnd = targetTitle ? undefined : (args.hwnd ?? context.window?.hwnd);
  if (hwnd !== undefined && hwnd !== null && args.focus !== false) payload.hwnd = hwnd;
  if (targetTitle) payload.title = targetTitle;
  const result = await fast.request(op, payload, timeoutMs);
  return { clicked: result?.clicked ?? [x, y], foreground: result?.foreground ?? null };
}

/** Directory that holds saved recipes: `$DSH_HOME/windows-control/recipes/<name>.json`. */
export function recipesDir(home) {
  return join(home, "windows-control", "recipes");
}

/**
 * Load a saved recipe by name. Accepts `{ steps: [...] }` or a bare array.
 * @returns {{ name: string, steps: unknown[], resolution?: number[] }}
 */
export function loadRecipe(name, home) {
  const file = join(recipesDir(home), `${name}.json`);
  if (!existsSync(file)) throw new Error(`no recipe named "${name}" at ${file}`);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const steps = Array.isArray(parsed) ? parsed : parsed?.steps;
  return { name, steps, resolution: Array.isArray(parsed?.resolution) ? parsed.resolution : undefined };
}
