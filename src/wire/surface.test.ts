import { describe, expect, it } from "vitest";
import { parseNode, parseSurface, surfaceButtons, surfaceFields } from "./surface";

/**
 * The surface payload is the reason a structured ask used to render as "this
 * question has no options". These tests pin the parsing rules that keep an
 * unknown or malformed node from taking the whole card down with it.
 */

const form = {
  spec_version: 1,
  title: "Configure",
  body: [
    { kind: "text", value: "Choose settings" },
    {
      kind: "field",
      key: "count",
      label: "Count",
      field: { type: "number", required: true, min: 1, max: 5, default: 2 },
    },
    {
      kind: "choice_card",
      key: "mode",
      label: "Mode",
      field: {
        type: "choice",
        options: [
          { value: "fast", label: "Fast", description: "Short run" },
          { value: "full", label: "Full" },
        ],
      },
    },
    { kind: "button", label: "Continue", actionId: "continue" },
  ],
};

describe("parseSurface", () => {
  it("reads a form and keeps every node", () => {
    const spec = parseSurface(form);
    expect(spec).not.toBeNull();
    expect(spec?.title).toBe("Configure");
    expect(spec?.body.map((node) => node.kind)).toEqual([
      "text",
      "field",
      "choice_card",
      "button",
    ]);
  });

  it("answers null for a payload it cannot draw", () => {
    // The caller draws nothing rather than an option question with no options.
    expect(parseSurface(null)).toBeNull();
    expect(parseSurface({ body: [] })).toBeNull();
    expect(parseSurface({ body: [{ nope: true }] })).toBeNull();
  });

  it("skips a node it does not understand without losing the rest", () => {
    const spec = parseSurface({
      body: [{ kind: "text", value: "still here" }, { kind: "future_widget", value: "x" }],
    });
    expect(spec?.body).toHaveLength(2);
    expect(spec?.body[1]?.kind).toBe("future_widget");
  });

  it("keeps a field's bounds and options", () => {
    const spec = parseSurface(form);
    const fields = surfaceFields(spec?.body ?? []);
    expect(fields.get("count")).toMatchObject({ type: "number", required: true, min: 1, max: 5 });
    expect(fields.get("mode")?.options?.map((option) => option.value)).toEqual(["fast", "full"]);
    expect(fields.get("mode")?.options?.[0]?.description).toBe("Short run");
  });

  it("finds buttons wherever they nest", () => {
    const spec = parseSurface({
      body: [
        {
          kind: "stack",
          children: [{ kind: "button", label: "Approve", actionId: "approve" }],
        },
      ],
    });
    expect(surfaceButtons(spec?.body ?? [])).toEqual([
      { label: "Approve", actionId: "approve" },
    ]);
  });
});

describe("parseNode", () => {
  it("reads the display-only nodes", () => {
    const meter = parseNode({ kind: "meter", label: "Used", progress: 0.4 });
    expect(meter).toMatchObject({ kind: "meter", label: "Used", progress: 0.4 });

    const kv = parseNode({ kind: "kv", key: "模型", value: "flash" });
    expect(kv).toMatchObject({ key: "模型", value: "flash" });

    const divider = parseNode({ kind: "divider" });
    expect(divider).toEqual({ kind: "divider" });
  });

  it("reads a diff and a dataset", () => {
    const diff = parseNode({
      kind: "diff_preview",
      label: "改动",
      diff: { before: "a", after: "b" },
    });
    expect(diff?.diff).toEqual({ before: "a", after: "b" });

    const dashboard = parseNode({
      kind: "dashboard",
      label: "Revenue",
      dataset: {
        categories: ["Jan", "Feb"],
        series: [{ id: "revenue", label: "Revenue", unit: "USD", values: [10, 20] }],
      },
    });
    expect(dashboard?.dataset?.categories).toEqual(["Jan", "Feb"]);
    expect(dashboard?.dataset?.series[0]?.values).toEqual([10, 20]);
  });

  it("drops a diff or dataset that is not shaped right", () => {
    expect(parseNode({ kind: "diff_preview", diff: { before: "a" } })?.diff).toBeUndefined();
    expect(parseNode({ kind: "dashboard", dataset: { categories: [] } })?.dataset).toBeUndefined();
  });

  it("answers null for a node with no kind", () => {
    expect(parseNode({ value: "orphan" })).toBeNull();
    expect(parseNode("just a string")).toBeNull();
  });
});

describe("surfaceFields", () => {
  it("collects nested inputs by key", () => {
    const spec = parseSurface({
      body: [
        {
          kind: "stack",
          children: [
            { kind: "field", key: "a", label: "A", field: { type: "string" } },
            { kind: "field", key: "b", label: "B", field: { type: "bool" } },
          ],
        },
      ],
    });
    expect([...(surfaceFields(spec?.body ?? []).keys())]).toEqual(["a", "b"]);
  });
});
