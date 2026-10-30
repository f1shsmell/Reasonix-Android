import { afterEach, describe, expect, it, vi } from "vitest";
import { currentModel, effortChoices, loadModels, modelShortName, switchEffort, switchModel } from "./models";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadModels", () => {
  it("reads the catalog and marks the active model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        current: "deepseek/deepseek-flash",
        label: "DeepSeek Flash",
        default: "deepseek/deepseek-pro",
        models: [
          {
            ref: "deepseek/deepseek-flash",
            provider: "deepseek",
            model: "deepseek-flash",
            active: true,
            efforts: ["low", "high"],
            effort: "high",
            vision: true,
            contextWindow: 128000,
          },
          {
            ref: "deepseek/deepseek-pro",
            provider: "deepseek",
            model: "deepseek-pro",
            default: true,
          },
          { ref: "" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadModels("/rt/r1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/models",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({
      ok: true,
      catalog: {
        current: "deepseek/deepseek-flash",
        label: "DeepSeek Flash",
        default: "deepseek/deepseek-pro",
        models: [
          {
            ref: "deepseek/deepseek-flash",
            provider: "deepseek",
            model: "deepseek-flash",
            active: true,
            default: false,
            efforts: ["low", "high"],
            effort: "high",
            vision: true,
            contextWindow: 128000,
          },
          {
            ref: "deepseek/deepseek-pro",
            provider: "deepseek",
            model: "deepseek-pro",
            active: false,
            default: true,
          },
        ],
      },
    });
  });

  it("marks the current ref active even when the row omits the flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          current: "a/b",
          models: [
            { ref: "a/b", provider: "a", model: "b" },
            { ref: "a/c", provider: "a", model: "c" },
          ],
        }),
      ),
    );
    const result = await loadModels("/rt/r1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalog.models.filter((entry) => entry.active).map((entry) => entry.ref)).toEqual(["a/b"]);
    }
  });

  it("carries a refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "provider.key_missing" }, 409)));
    await expect(loadModels("/rt/r1")).resolves.toEqual({ ok: false, code: "provider.key_missing" });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(loadModels("/rt/r1")).resolves.toEqual({ ok: false, code: "client.offline" });
  });
});

describe("switchModel", () => {
  it("posts the ref to this pane only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(switchModel("/rt/r1", " deepseek/deepseek-pro ")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/model",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ref: "deepseek/deepseek-pro" }),
      }),
    );
  });

  it("keeps the kernel's refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "model.unknown" }, 400)));
    await expect(switchModel("/rt/r1", "x/y")).resolves.toEqual({ ok: false, code: "model.unknown" });
  });

  it("does not post an empty ref", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(switchModel("/rt/r1", "  ")).resolves.toEqual({ ok: false, code: "client.empty_ref" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(switchModel("/rt/r1", "a/b")).resolves.toEqual({ ok: false, code: "client.offline" });
  });
});

describe("catalog helpers", () => {
  const catalog = {
    current: "a/b",
    label: "B",
    default: "a/c",
    models: [
      { ref: "a/b", provider: "a", model: "b", active: false, default: false },
      { ref: "a/c", provider: "a", model: "c", active: true, default: true },
    ],
  };

  it("names the active model, not the provider's prefix", () => {
    expect(currentModel(catalog)).toBe("c");
    expect(modelShortName(catalog.models[0]!)).toBe("b");
  });

  it("falls back to the kernel's label when no row is active", () => {
    expect(currentModel({ ...catalog, models: [] })).toBe("B");
    expect(currentModel({ current: "x/y", label: "", default: "", models: [] })).toBe("x/y");
  });
});

describe("switchEffort", () => {
  it("posts the effort to this pane", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(switchEffort("/rt/r1", "high")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/effort",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ effort: "high" }),
      }),
    );
  });

  it("sends auto as the kernel spells it", async () => {
    // The kernel's own display test asserts `auto` round-trips as an empty
    // effort; inventing a different spelling here would be refused.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await switchEffort("/rt/r1", "auto");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/effort",
      expect.objectContaining({ body: JSON.stringify({ effort: "auto" }) }),
    );
  });

  it("keeps the kernel's refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "model.effort_unsupported" }, 400)));
    await expect(switchEffort("/rt/r1", "high")).resolves.toEqual({
      ok: false,
      code: "model.effort_unsupported",
    });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(switchEffort("/rt/r1", "high")).resolves.toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});

describe("effortChoices", () => {
  it("puts auto first and keeps the model's own order", () => {
    expect(effortChoices({ ref: "a/b", provider: "a", model: "b", active: false, default: false, efforts: ["low", "high"] })).toEqual([
      "auto",
      "low",
      "high",
    ]);
  });

  it("does not offer auto twice when the model already declares it", () => {
    expect(
      effortChoices({ ref: "a/b", provider: "a", model: "b", active: false, default: false, efforts: ["auto", "high"] }),
    ).toEqual(["auto", "high"]);
  });

  it("offers nothing for a model that declares no efforts", () => {
    expect(effortChoices({ ref: "a/b", provider: "a", model: "b", active: false, default: false })).toEqual([]);
    expect(effortChoices(undefined)).toEqual([]);
    expect(
      effortChoices({ ref: "a/b", provider: "a", model: "b", active: false, default: false, efforts: [] }),
    ).toEqual([]);
  });
});
