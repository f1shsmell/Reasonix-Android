import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkUpload } from "./relayBulk";
import type { BulkHost } from "./relayBulk";

const PART = 24 * 1024;

function harness(size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  const sent: Array<Record<string, unknown>> = [];
  const parts: Uint8Array[] = [];
  const gates: Array<() => void> = [];
  let buffered = 0;
  let failure: unknown = null;
  const host: BulkHost = {
    send: async (command) => {
      sent.push(command);
    },
    sendBinary: (part) => {
      parts.push(part);
      return new Promise<void>((resolve) => gates.push(resolve));
    },
    buffered: () => buffered,
  };
  const upload = new BulkUpload(
    "up1",
    "/rt/r1/attachments",
    "photo.png",
    "image/png",
    bytes,
    host,
    (error) => {
      failure = error;
    },
  );
  return {
    upload,
    sent,
    parts,
    bytes,
    failure: () => failure,
    setBuffered: (value: number) => {
      buffered = value;
    },
    release: () => gates.shift()?.(),
    open: () => sent.find((item) => item.type === "bulk.open"),
  };
}

function indexOf(part: Uint8Array): number {
  return new DataView(part.buffer, part.byteOffset, part.byteLength).getUint32(0);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe("BulkUpload", () => {
  it("opens with the attachment metadata and sends indexed parts", async () => {
    const rig = harness(50_000);
    void rig.upload.run();
    await tick();
    expect(rig.open()).toMatchObject({
      v: 1,
      type: "bulk.open",
      id: "up1",
      path: "/rt/r1/attachments",
      name: "photo.png",
      mime: "image/png",
      total: 3,
    });

    rig.upload.ready({ next: 0 });
    for (let i = 0; i < 3; i += 1) {
      await tick();
      rig.release();
    }
    await tick();

    expect(rig.parts.map(indexOf)).toEqual([0, 1, 2]);
    expect(rig.parts[0]?.length).toBe(4 + PART);
    expect(rig.parts[2]?.length).toBe(4 + 50_000 - 2 * PART);
    expect(rig.parts[0]?.subarray(4)).toEqual(rig.bytes.subarray(0, PART));
    expect(rig.parts[2]?.subarray(4)).toEqual(rig.bytes.subarray(2 * PART));
    expect(rig.failure()).toBeNull();
  });

  it("resumes from the part count the kernel holds", async () => {
    const rig = harness(3 * PART);
    void rig.upload.run();
    await tick();
    rig.upload.ready({ next: 2 });
    await tick();
    rig.release();
    await tick();
    expect(rig.parts.map(indexOf)).toEqual([2]);
    expect(rig.parts[0]?.subarray(4)).toEqual(rig.bytes.subarray(2 * PART));
  });

  it("pauses on a lost link and reopens with the same id after it returns", async () => {
    const rig = harness(3 * PART);
    void rig.upload.run();
    await tick();
    rig.upload.ready({ next: 0 });
    await tick();
    expect(rig.parts.map(indexOf)).toEqual([0]);

    rig.upload.lost();
    rig.release();
    await tick();
    await tick();
    expect(rig.parts.length).toBe(1);

    rig.upload.reconnected();
    await tick();
    const opens = rig.sent.filter((item) => item.type === "bulk.open");
    expect(opens.length).toBe(2);
    expect(opens[1]?.id).toBe("up1");
    rig.upload.ready({ next: 1 });
    for (let i = 0; i < 2; i += 1) {
      await tick();
      rig.release();
    }
    await tick();
    expect(rig.parts.map(indexOf)).toEqual([0, 1, 2]);
    expect(rig.failure()).toBeNull();
  });

  it("stops sending once the answer has settled", async () => {
    const rig = harness(3 * PART);
    void rig.upload.run();
    await tick();
    rig.upload.ready({ next: 0 });
    await tick();
    rig.upload.abort();
    rig.release();
    await tick();
    await tick();
    expect(rig.parts.length).toBe(1);
  });

  it("waits for the socket buffer to drain before sending more", async () => {
    vi.useFakeTimers();
    const rig = harness(2 * PART);
    rig.setBuffered(2 * 1024 * 1024);
    void rig.upload.run();
    await vi.advanceTimersByTimeAsync(0);
    rig.upload.ready({ next: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.parts.length).toBe(0);
    rig.setBuffered(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.parts.length).toBe(1);
    rig.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.parts.length).toBe(2);
    rig.release();
  });

  it("fails when the kernel never acknowledges the open", async () => {
    vi.useFakeTimers();
    const rig = harness(PART);
    void rig.upload.run();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(rig.failure()).toBeInstanceOf(Error);
  });

  it("fails when no part makes progress for a minute", async () => {
    vi.useFakeTimers();
    const rig = harness(2 * PART);
    void rig.upload.run();
    await vi.advanceTimersByTimeAsync(0);
    rig.upload.ready({ next: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.parts.length).toBe(1);
    // The first part's send never completes; the watchdog must notice.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(rig.failure()).toBeInstanceOf(Error);
  });
});