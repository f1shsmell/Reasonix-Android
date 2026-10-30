import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_CHOICES, approvalLabel, approvalMessage, setApprovalMode } from "./approval";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("setApprovalMode", () => {
  it("posts the kernel's own word for the posture", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(setApprovalMode("/rt/r1", "auto")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/tool-approval-mode",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "auto" }) }),
    );
  });

  it("uses the wire values the kernel accepts, not the labels", async () => {
    // `ParseToolApprovalMode` refuses anything else; a translated word here
    // would be a 400 the person could not explain.
    expect(APPROVAL_CHOICES.map((choice) => choice.value)).toEqual([
      "readOnly",
      "ask",
      "auto",
      "dontAsk",
      "yolo",
    ]);
  });

  it("does not post an empty mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(setApprovalMode("/rt/r1", " ")).resolves.toEqual({
      ok: false,
      code: "client.empty_mode",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "request.bad_value" }, 400)));
    await expect(setApprovalMode("/rt/r1", "nope")).resolves.toEqual({
      ok: false,
      code: "request.bad_value",
    });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(setApprovalMode("/rt/r1", "auto")).resolves.toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});

describe("approvalLabel", () => {
  it("names a known posture", () => {
    expect(approvalLabel("ask")).toBe("逐次询问");
    expect(approvalLabel("yolo")).toBe("全放开");
  });

  it("shows an unknown value as it arrived rather than guessing", () => {
    expect(approvalLabel("future_mode")).toBe("future_mode");
    expect(approvalLabel(undefined)).toBe("");
  });
});

describe("approvalMessage", () => {
  it("turns a refusal into a sentence", () => {
    expect(approvalMessage("client.offline")).toContain("连不上");
    expect(approvalMessage("request.bad_value")).toContain("request.bad_value");
  });
});
