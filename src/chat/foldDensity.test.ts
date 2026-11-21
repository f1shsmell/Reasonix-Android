/**
 * The three fold densities must be tellable apart, and the rich demo
 * transcript is what a review judges them on: without a finished tool run in
 * it, every density draws the same picture and a screenshot proves nothing.
 * This pins the demo's shape through the same conversion a real session
 * takes, and the distinct drawing each density gives it.
 */
import { expect, it } from "vitest";
import { foldHistory } from "../net/history";
import { richMessages } from "../net/mock/kernel";
import { buildDisplay } from "./process";
import type { FoldMode } from "./folding";

const rows = foldHistory(richMessages);

it("the rich demo carries a finished tool run: thinking, a diff, a failure", () => {
  const tools = rows.filter((row) => row.kind === "tool");
  expect(tools.length).toBeGreaterThanOrEqual(4);
  expect(tools.filter((row) => row.kind === "tool" && row.reasoning?.trim()).length).toBeGreaterThanOrEqual(2);
  expect(tools.filter((row) => row.kind === "tool" && row.outputDiff).length).toBe(1);
  expect(tools.filter((row) => row.kind === "tool" && row.err).length).toBe(1);
  expect(rows.filter((row) => row.kind === "assistant" && row.text.trim()).length).toBe(2);
});

const shape = (fold: FoldMode) => {
  const entries = buildDisplay(rows, false, fold);
  const steps = entries.filter((entry) => entry.kind === "steps");
  return {
    folds: steps.map((entry) => (entry.kind === "steps" ? entry.steps.length : 0)),
    bubbles: entries.filter((entry) => entry.kind === "assistant").length,
    allLive: steps.every((entry) => entry.kind === "steps" && entry.live),
    compact: steps.some((entry) => entry.kind === "steps" && entry.compact === true),
  };
};

it("full draws every step on its own row", () => {
  const full = shape("full");
  expect(full.bubbles).toBe(2);
  expect(full.allLive).toBe(true);
  expect(full.compact).toBe(false);
});

it("standard folds the calls but keeps the narration as bubbles", () => {
  const standard = shape("standard");
  expect(standard.bubbles).toBe(2);
  // Two runs: the read (thinking + call), then the edit, failed test and
  // retry (their thinking riding ahead of each call).
  expect(standard.folds).toEqual([2, 5]);
  expect(standard.allLive).toBe(false);
});

it("compact folds even the narration: only the words that ended the run stand", () => {
  const compact = shape("compact");
  expect(compact.bubbles).toBe(1);
  // Everything between the ask and the answer rides the fold: thinking,
  // calls, and the narration between them.
  expect(compact.folds).toEqual([8]);
  expect(compact.compact).toBe(true);
});
