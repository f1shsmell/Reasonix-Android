import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "./drafts";

describe("drafts", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("starts empty and keeps exactly what was typed", () => {
    expect(loadDraft("r1")).toBe("");
    saveDraft("r1", "第一行\n第二行 ");
    expect(loadDraft("r1")).toBe("第一行\n第二行 ");
  });

  it("does not show one session's draft in another", () => {
    saveDraft("r1", "one");
    saveDraft("r2", "two");
    expect(loadDraft("r1")).toBe("one");
    expect(loadDraft("r2")).toBe("two");
  });

  it("removes the key when the text is cleared", () => {
    saveDraft("r1", "draft");
    saveDraft("r1", "");
    expect(loadDraft("r1")).toBe("");
    expect(localStorage.getItem("reasonix.draft.r1")).toBeNull();
  });

  it("clears a sent draft so it cannot be restored", () => {
    saveDraft("r1", "sent");
    clearDraft("r1");
    expect(loadDraft("r1")).toBe("");
  });
});
