import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStep, runRecipe, validateRecipe } from "../lib/recipe.js";

/** A fastpath stand-in that records every op and replays canned answers. */
function fakeFast(answers = {}) {
  const calls = [];
  return {
    calls,
    async request(op, args) {
      calls.push({ op, args });
      const handler = answers[op];
      if (typeof handler === "function") return handler(args, calls);
      return { ok: true, ms: 1 };
    },
  };
}

const WINDOW = { hwnd: 42, title: "Game", x: 100, y: 50, w: 800, h: 600 };

test("a step may be written with an explicit op or as a single op-named key", () => {
  assert.deepEqual(normalizeStep({ op: "click", at: [1, 2] }, 0), { op: "click", args: { at: [1, 2] } });
  assert.deepEqual(normalizeStep({ click: { at: [1, 2] } }, 0), { op: "click", args: { at: [1, 2] } });
  assert.deepEqual(normalizeStep({ sleep: { ms: 5 } }, 0), { op: "sleep", args: { ms: 5 } });
  assert.deepEqual(normalizeStep({ "wait_window": { title: "Game" } }, 0), { op: "wait_window", args: { title: "Game" } });
});

test("validation fails before any side effect", () => {
  assert.equal(validateRecipe([]).ok, false);
  assert.match(validateRecipe([{ op: "nope" }]).error, /unknown op/);
  assert.match(validateRecipe([{ click: {} }]).error, /needs "at"/);
  assert.match(validateRecipe([{ launch: {} }]).error, /needs "path"/);
  assert.match(validateRecipe([{ focus: {} }]).error, /needs "title" or "hwnd"/);
  assert.equal(validateRecipe([{ sleep: { ms: 1 } }]).ok, true);
});

test("a recipe runs in order, times every step and carries the window forward", async () => {
  const fast = fakeFast({
    launch: () => ({ ok: true, pid: 7, elapsedMs: 900, window: WINDOW }),
    click: (args) => ({ ok: true, clicked: [args.x, args.y], foreground: 42 }),
    pixel: () => ({ ok: true, hex: "#112233" }),
  });
  const result = await runRecipe(
    [
      { launch: { path: "C:/game.exe", title: "Game" } },
      { click: { at: [10, 20], relative: true } },
      { pixel: { at: [1, 1] } },
    ],
    { fast },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(fast.calls.map((call) => call.op), ["launch", "click", "pixel"]);
  // relative coordinates are resolved against the launched window
  assert.deepEqual([fast.calls[1].args.x, fast.calls[1].args.y], [110, 70]);
  assert.deepEqual(result.window, WINDOW);
  assert.equal(result.steps.length, 3);
  assert.ok(result.steps.every((step) => typeof step.ms === "number"));
});

test("a failing step stops the recipe and names the index", async () => {
  const fast = fakeFast({
    launch: () => ({ ok: true, pid: 7, window: WINDOW }),
    click: () => {
      throw new Error("window did not reach the foreground");
    },
  });
  const result = await runRecipe(
    [{ launch: { path: "C:/game.exe" } }, { click: { at: [1, 1] } }, { sleep: { ms: 1 } }],
    { fast },
  );
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 1);
  assert.match(result.error, /foreground/);
  assert.equal(result.steps.length, 2, "the third step never ran");
});

test("retries repeat a step and are reported", async () => {
  let attempts = 0;
  const fast = fakeFast({
    click: () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not yet");
      return { ok: true };
    },
  });
  const result = await runRecipe([{ click: { at: [1, 1], retries: 3, retryDelayMs: 0 } }], { fast });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].attempts, 3);
  assert.equal(attempts, 3);
});

test("click_until retries the click until the pixel predicate holds", async () => {
  let clicks = 0;
  const fast = fakeFast({
    click: () => {
      clicks += 1;
      return { ok: true };
    },
    pixel: () => ({ ok: true, hex: clicks >= 2 ? "#A8AC97" : "#308332" }),
  });
  const result = await runRecipe(
    [
      {
        click_until: {
          at: [440, 724],
          retries: 3,
          timeoutMs: 800,
          until: { pixel: [600, 730], hex: "#A8AC97" },
        },
      },
    ],
    { fast },
  );
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].detail.attempts, 2);
  assert.equal(clicks, 2);
});

test("click_until reports the predicate it could not satisfy", async () => {
  const fast = fakeFast({
    click: () => ({ ok: true }),
    pixel: () => ({ ok: true, hex: "#000000" }),
  });
  const result = await runRecipe(
    [{ click_until: { at: [1, 1], retries: 2, timeoutMs: 300, until: { pixel: [1, 1], hex: "#FFFFFF" } } }],
    { fast },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /never satisfied/);
  assert.match(result.error, /#FFFFFF/);
});

test("assert fails loudly with the observed value", async () => {
  const fast = fakeFast({ pixel: () => ({ ok: true, hex: "#000000" }) });
  const result = await runRecipe([{ assert: { pixel: [5, 5], hex: "#FFFFFF" } }], { fast });
  assert.equal(result.ok, false);
  assert.match(result.error, /expected #FFFFFF got #000000/);
});

test("wait_window switches to the size-aware predicate only when a size is asked for", async () => {
  const fast = fakeFast({ wait: () => ({ ok: true, window: WINDOW, elapsedMs: 12 }) });
  await runRecipe([{ wait_window: { title: "Game" } }], { fast });
  await runRecipe([{ wait_window: { title: "Game", minWidth: 1900, stableMs: 600 } }], { fast });
  assert.equal(fast.calls[0].args.mode, "window");
  assert.equal(fast.calls[1].args.mode, "window_size");
  assert.equal(fast.calls[1].args.minWidth, 1900);
  assert.equal(fast.calls[1].args.stableMs, 600);
});
