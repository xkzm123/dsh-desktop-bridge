/**
 * dsh-windows-control — native tools (the fast path's model-facing surface).
 *
 * Two tools, deliberately:
 *
 *   windows_fast   one primitive per call (windows/rect/focus/launch/click/key/
 *                  type/pixel/wait/kill) for interactive, step-by-step work.
 *   windows_run    a recipe: many primitives in one call, executed at local
 *                  speed, with per-step timings and verified transitions.
 *
 * The second one is the point. Driving Kingdom Rush Origins to its first battle
 * through the MCP bridge took 18 model round trips and 304 s of wall clock while
 * the desktop work itself was ~6 s; the same path as a recipe is one call and
 * ~19 s of local execution.
 *
 * Both tools are gated by the Computer Use switch exactly like the bridged ones.
 */
import { join } from "node:path";

import { FASTPATH_OPS, createFastPath } from "./fastpath.js";
import { loadRecipe, runRecipe, validateRecipe } from "./recipe.js";

export const FAST_TOOL_NAME = "windows_fast";
export const RUN_TOOL_NAME = "windows_run";
export const NATIVE_TOOL_NAMES = new Set([FAST_TOOL_NAME, RUN_TOOL_NAME]);

const FAST_DESCRIPTION =
  "Direct Win32 control of this desktop, no UIA tree and no control gate: 20-120 ms per call. " +
  "ops: windows (visible windows + physical-pixel rects), rect, focus, launch (start a process and wait for its window), " +
  "click (absolute virtual-desktop coordinates; pass title/hwnd to focus first), move, key (\"ctrl+s\", \"F5\"), type (unicode), " +
  "pixel (read one pixel as #rrggbb), wait (mode: window|window_size|pixel|idle), kill. " +
  "Use it instead of mcp__windows__Snapshot when you need geometry, a launch, or a click that must land; " +
  "use mcp__windows__Screenshot when you need to SEE the screen. For multi-step work prefer windows_run.";

const RUN_DESCRIPTION =
  "Run a recipe of desktop steps in ONE call: launch, wait_window, focus, rect, click, click_until, key, type, pixel, wait_pixel, wait_idle, assert, sleep. " +
  "Steps may be given inline (steps) or loaded from a saved profile (profile). Each step is timed and returned; " +
  "click_until retries a click until a window grew or a pixel changed, which is what makes a game menu reliable. " +
  "Example: [{\"launch\":{\"path\":\"C:\\\\game.exe\",\"title\":\"Game\"}},{\"click_until\":{\"at\":[440,724],\"until\":{\"pixel\":[600,730],\"not\":\"#308332\"}}}]";

/** @returns the tools registered on this scoped context, or [] */
export function registerNativeTools({ ctx, warn, isEnabled, home }) {
  if (typeof ctx?.inject !== "function") return;
  /** Lazily created so a profile that never calls the fast path never spawns PowerShell. */
  let fast = null;
  const sidecar = () => {
    if (fast === null) fast = createFastPath({ logger: (line) => warn(line) });
    return fast;
  };

  try {
    ctx.inject(["tools"], (scoped) => {
      try {
        if (typeof scoped?.tools?.register !== "function") return;
        const off = () =>
          isEnabled()
            ? null
            : {
                ok: false,
                error:
                  "Computer Use is switched off, so desktop control is unavailable. Switch the Computer Use control back on in the composer and retry.",
              };

        const disposeFast = scoped.tools.register({
          name: FAST_TOOL_NAME,
          description: FAST_DESCRIPTION,
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["op"],
            properties: {
              op: { type: "string", enum: FASTPATH_OPS },
              hwnd: { type: "integer", description: "Window handle from `windows`." },
              title: { type: "string", description: "Window title, matched as a regular expression." },
              filter: { type: "string", description: "windows: keep titles/classes matching this regex." },
              x: { type: "integer" },
              y: { type: "integer" },
              w: { type: "integer" },
              h: { type: "integer" },
              button: { type: "string", enum: ["left", "right", "middle"] },
              clicks: { type: "integer" },
              path: { type: "string", description: "launch: absolute executable path." },
              args: { type: "array", items: { type: "string" } },
              waitMs: { type: "integer", description: "launch: how long to wait for the window." },
              combo: { type: "string", description: 'key: "ENTER", "F5", "ctrl+shift+s".' },
              text: { type: "string", description: "type: unicode text." },
              hex: { type: "string", description: 'wait: expected colour, "#RRGGBB".' },
              mode: { type: "string", enum: ["window", "window_size", "pixel", "idle"] },
              minWidth: { type: "integer" },
              minHeight: { type: "integer" },
              stableMs: { type: "integer", description: "wait: how long the window must stay put." },
              timeoutMs: { type: "integer" },
              pid: { type: "integer" },
            },
          },
          output: {
            schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
            render(_args, value) {
              return [{ type: "text", text: String(value?.result ?? "") }];
            },
          },
          async execute(args) {
            const blocked = off();
            if (blocked) return { result: JSON.stringify(blocked) };
            const op = String(args?.op ?? "");
            if (!FASTPATH_OPS.includes(op)) return { result: JSON.stringify({ ok: false, error: `unknown op "${op}"` }) };
            const { op: _ignored, ...rest } = args;
            try {
              const value = await sidecar().request(op, rest, Number(rest.timeoutMs ?? 0) > 0 ? Number(rest.timeoutMs) + 5000 : 30000);
              return { result: JSON.stringify(value) };
            } catch (error) {
              return { result: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) };
            }
          },
        });

        const disposeRun = scoped.tools.register({
          name: RUN_TOOL_NAME,
          description: RUN_DESCRIPTION,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              steps: { type: "array", items: { type: "object" }, description: "Recipe steps, in order." },
              profile: { type: "string", description: "Name of a saved recipe in $DSH_HOME/windows-control/recipes/<name>.json" },
              timeoutMs: { type: "integer", description: "Default per-step timeout." },
            },
          },
          output: {
            schema: {
              type: "object",
              properties: { report: { type: "string" }, ok: { type: "boolean" } },
              required: ["report", "ok"],
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: "text", text: String(value?.report ?? "") }];
            },
          },
          async execute(args) {
            const blocked = off();
            if (blocked) return { ok: false, report: blocked.error };
            let steps = Array.isArray(args?.steps) ? args.steps : null;
            let label = "inline";
            try {
              if (!steps) {
                const name = typeof args?.profile === "string" ? args.profile : "";
                if (name === "") return { ok: false, report: "windows_run needs either `steps` or `profile`." };
                const loaded = loadRecipe(name, home);
                steps = loaded.steps;
                label = name;
              }
              const validated = validateRecipe(steps);
              if (!validated.ok) return { ok: false, report: `invalid recipe: ${validated.error}` };
              const result = await runRecipe(validated.steps, {
                fast: sidecar(),
                defaultTimeoutMs: Number(args?.timeoutMs ?? 0) > 0 ? Number(args.timeoutMs) : undefined,
                logger: (line) => warn(line),
              });
              return { ok: result.ok, report: formatReport(label, result) };
            } catch (error) {
              return { ok: false, report: `windows_run failed: ${error instanceof Error ? error.message : String(error)}` };
            }
          },
        });

        for (const dispose of [disposeFast, disposeRun]) {
          try {
            if (typeof dispose === "function" && typeof scoped.on === "function") scoped.on("dispose", dispose);
          } catch {
            /* best effort */
          }
        }
        try {
          if (typeof scoped.on === "function") scoped.on("dispose", () => fast?.dispose());
        } catch {
          /* best effort */
        }
      } catch (error) {
        warn(`could not register the native desktop tools: ${String(error)}`);
      }
    });
  } catch (error) {
    warn(`could not inject the tools service for the native desktop tools: ${String(error)}`);
  }
}

/** Compact, model-readable report: one line per step, failures first. */
export function formatReport(label, result) {
  const lines = [];
  lines.push(`recipe ${label}: ${result.ok ? "ok" : "FAILED"} in ${result.elapsedMs} ms`);
  for (const step of result.steps ?? []) {
    const detail = step.ok ? "" : `  <- ${step.error}`;
    const attempts = step.attempts && step.attempts > 1 ? ` (${step.attempts} attempts)` : "";
    lines.push(`  ${String(step.index).padStart(2)} ${step.op.padEnd(12)} ${String(step.ms).padStart(6)} ms${attempts}${detail}`);
  }
  if (!result.ok) lines.push(`failed at step ${result.failedAt}: ${result.error}`);
  if (result.window) {
    const w = result.window;
    lines.push(`window: ${w.title} ${w.w}x${w.h} at ${w.x},${w.y} (hwnd ${w.hwnd})`);
  }
  return lines.join("\n");
}

/** Where saved recipes live; re-exported so the doctor can point at it. */
export function recipesPath(home) {
  return join(home, "windows-control", "recipes");
}
