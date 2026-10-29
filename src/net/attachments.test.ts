import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_MB, isolateImageRefs, uploadImage } from "./attachments";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("isolateImageRefs", () => {
  it("separates a reference glued to the following words", () => {
    expect(isolateImageRefs("@.reasonix/attachments/a.png看这个")).toBe(
      "@.reasonix/attachments/a.png 看这个",
    );
  });

  it("separates a reference glued to the preceding words", () => {
    expect(isolateImageRefs("看@.reasonix/attachments/a.png")).toBe(
      "看 @.reasonix/attachments/a.png",
    );
  });

  it("leaves an already separated reference alone", () => {
    expect(isolateImageRefs("@.reasonix/attachments/a.png\n看这个")).toBe(
      "@.reasonix/attachments/a.png\n看这个",
    );
  });
});

describe("uploadImage", () => {
  it("encodes the image into the verified JSON attachment route", async () => {
    const file = new File(["image-bytes"], "photo.png", { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue(
      json({ path: ".reasonix/attachments/photo.png", ref: "@.reasonix/attachments/photo.png", image: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadImage("/rt/r1", file);

    expect(result).toEqual({
      ok: true,
      attachment: {
        path: ".reasonix/attachments/photo.png",
        ref: "@.reasonix/attachments/photo.png",
        image: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/attachments",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      name: string;
      mime: string;
      data: string;
    };
    expect(body.name).toBe("photo.png");
    expect(body.mime).toBe("image/png");
    expect(body.data).toBe("aW1hZ2UtYnl0ZXM=");
  });

  it("infers an image MIME from the extension when the picker omits it", async () => {
    const file = new File(["image-bytes"], "PHOTO.PNG", { type: "" });
    const fetchMock = vi.fn().mockResolvedValue(json({ path: "p", ref: "@p" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadImage("/rt/r1", file);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { mime: string };
    expect(body.mime).toBe("image/png");
  });

  it("refuses a non-image before reading it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["apk"], "app.apk", { type: "application/vnd.android.package-archive" });

    await expect(uploadImage("/rt/r1", file)).resolves.toEqual({
      ok: false,
      code: "attachment.unsupported_image",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an image over the kernel's cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = { name: "huge.png", type: "image/png", size: MAX_IMAGE_MB * 1024 * 1024 + 1 } as File;

    await expect(uploadImage("/rt/r1", file)).resolves.toEqual({
      ok: false,
      code: "attachment.too_large",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the kernel's refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "attachment.not_text" }, 415)));
    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(uploadImage("/rt/r1", file)).resolves.toEqual({
      ok: false,
      code: "attachment.not_text",
    });
  });

  it("reports a dead transport as offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const file = new File(["x"], "a.png", { type: "image/png" });
    await expect(uploadImage("/rt/r1", file)).resolves.toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});
