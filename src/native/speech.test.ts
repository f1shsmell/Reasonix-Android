import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginSpeechHold, CANCEL_DISTANCE, WAVE_BARS } from "./speech";

// The plugin is a singleton at module scope and Capacitor delivers an event
// to every listener ever registered, so the mock mirrors that broadcast; the
// tests drive the page's own session filtering through it.
const mocks = vi.hoisted(() => {
  const calls = {
    listen: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  return { calls, listeners };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({
    addListener: async (event: string, handler: (data: Record<string, unknown>) => void) => {
      const set = mocks.listeners.get(event) ?? new Set<(data: Record<string, unknown>) => void>();
      set.add(handler);
      mocks.listeners.set(event, set);
      return { remove: async () => set.delete(handler) };
    },
    listen: mocks.calls.listen,
    stop: mocks.calls.stop,
    cancel: mocks.calls.cancel,
  }),
}));

/** Deliver one plugin event to every listener, the way the bridge does. */
function fire(event: string, data: Record<string, unknown> = {}): void {
  for (const handler of [...(mocks.listeners.get(event) ?? [])]) handler(data);
}

interface Snapshot {
  transcript: string;
  levels: number[];
  ready: boolean;
  cancelArmed: boolean;
  ended: boolean;
  error: string;
}

/** Begin a hold and drive it to the point where events can be fired at it. */
async function holding(): Promise<{ updates: Snapshot[]; hold: NonNullable<Awaited<ReturnType<typeof beginSpeechHold>>["hold"]> }> {
  const updates: Snapshot[] = [];
  const pending = beginSpeechHold((state) => updates.push({ ...state }));
  await Promise.resolve();
  await Promise.resolve();
  const result = await pending;
  if (!result.hold) throw new Error("hold did not start");
  return { updates, hold: result.hold };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.listeners.clear();
  mocks.calls.listen.mockReset().mockResolvedValue({ session: 7 });
  mocks.calls.stop.mockReset().mockResolvedValue(undefined);
  mocks.calls.cancel.mockReset().mockResolvedValue(undefined);
});

describe("beginSpeechHold", () => {
  it("streams partials and levels into the state", async () => {
    const { updates, hold } = await holding();

    fire("ready", { session: 7 });
    fire("volume", { session: 7, value: 5 });
    fire("partial", { session: 7, text: "把会话" });
    fire("partial", { session: 7, text: "把会话恢复" });

    expect(hold.state.transcript).toBe("把会话恢复");
    expect(hold.state.ready).toBe(true);
    expect(hold.state.levels).toHaveLength(WAVE_BARS);
    expect(hold.state.levels.at(-1)).toBeCloseTo(0.5);
    expect(updates.length).toBeGreaterThanOrEqual(3);
  });

  it("drops events from another session", async () => {
    const { hold } = await holding();

    fire("partial", { session: 8, text: "别人的话" });
    fire("final", { session: 8, text: "别人的话" });

    expect(hold.state.transcript).toBe("");
    expect(hold.state.ended).toBe(false);
  });

  it("buffers events that arrive before the session id is known", async () => {
    // listen() only resolves when the test lets it; a fast service may talk
    // before the page knows which session is its own.
    let accept!: (value: { session?: number }) => void;
    mocks.calls.listen.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    const updates: Snapshot[] = [];
    const pending = beginSpeechHold((state) => updates.push({ ...state }));
    await settled();
    fire("ready", { session: 7 });
    fire("volume", { session: 7, value: 6 });
    accept({ session: 7 });
    const result = await pending;

    expect(result.hold?.state.ready).toBe(true);
    expect(result.hold?.state.levels.at(-1)).toBeCloseTo(0.6);
  });

  it("ends exactly once on the final result and delivers its text", async () => {
    const { updates, hold } = await holding();

    fire("partial", { session: 7, text: "恢复会话" });
    fire("final", { session: 7, text: "恢复会话" });
    fire("final", { session: 7, text: "恢复会话" });
    fire("partial", { session: 7, text: "迟到" });

    expect(hold.state.ended).toBe(true);
    expect(hold.state.transcript).toBe("恢复会话");
    const ends = updates.filter((state) => state.ended);
    expect(ends).toHaveLength(1);
  });

  it("discards the transcript when the finger slid up to cancel", async () => {
    const { hold } = await holding();

    fire("partial", { session: 7, text: "说错的话" });
    hold.move(-CANCEL_DISTANCE - 10);
    expect(hold.state.cancelArmed).toBe(true);
    hold.move(0);
    expect(hold.state.cancelArmed).toBe(false);
    hold.move(-CANCEL_DISTANCE - 1);
    hold.release();

    expect(hold.state.ended).toBe(true);
    expect(hold.state.transcript).toBe("");
    expect(mocks.calls.cancel).toHaveBeenCalled();
  });

  it("stops the service on release and delivers the partial when the final is lost", async () => {
    vi.useFakeTimers();
    try {
      const { hold } = await holding();
      fire("ready", { session: 7 });
      fire("partial", { session: 7, text: "只有一半" });
      hold.release();
      expect(mocks.calls.stop).toHaveBeenCalled();
      expect(hold.state.ended).toBe(false);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(hold.state.ended).toBe(true);
      expect(hold.state.transcript).toBe("只有一半");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces recognizer errors in words and ends the hold", async () => {
    const { updates, hold } = await holding();

    fire("recerror", { session: 7, error: 6 });

    expect(hold.state.ended).toBe(true);
    expect(hold.state.transcript).toBe("");
    expect(hold.state.error).toBe("等太久没有说话");
    expect(updates.at(-1)?.ended).toBe(true);
  });

  it("names the phone's speech service, not the desktop link, on ERROR_NETWORK", async () => {
    const { hold } = await holding();

    fire("recerror", { session: 7, error: 2 });

    expect(hold.state.ended).toBe(true);
    // Saying only "网络" made people think the pairing had dropped.
    expect(hold.state.error).toContain("与电脑连接无关");
    expect(hold.state.error).not.toContain("检查网络后重试");
    // The trigger is the phone's VPN/proxy, and the fix lives in the VPN
    // client: the app cannot re-route another process's sockets.
    expect(hold.state.error).toContain("VPN/代理");
    expect(hold.state.error).toContain("白名单");
  });

  it("ends a tap that never reached the service without blaming it", async () => {
    const { hold } = await holding();

    // Released before any ready event: too short to be a word, not a
    // service failure.
    hold.release();

    expect(hold.state.ended).toBe(true);
    expect(hold.state.error).toBe("");
  });

  it("tells a refused microphone from a missing recognizer", async () => {
    mocks.calls.listen.mockResolvedValue({ reason: "denied" });
    const refused = await beginSpeechHold(() => {});
    expect(refused).toEqual({ hold: null, reason: "denied" });

    mocks.calls.listen.mockResolvedValue({ reason: "no-service" });
    const missing = await beginSpeechHold(() => {});
    expect(missing).toEqual({ hold: null, reason: "no-service" });
  });

  it("abandons a hold the page left behind and frees the mic for the next", async () => {
    const first = await holding();
    const second = await holding();

    expect(first.hold.state.ended).toBe(true);
    expect(second.hold.state.ended).toBe(false);
    expect(mocks.calls.cancel).toHaveBeenCalled();
  });

  it("stops nothing when release lands before the hold exists", async () => {
    // beginSpeechHold is still awaiting its listeners when release fires.
    const updates: Snapshot[] = [];
    const pending = beginSpeechHold((state) => updates.push({ ...state }));
    await Promise.resolve();
    await Promise.resolve();
    const result = await pending;
    result.hold?.release();
    await settled();

    expect(result.hold?.state.ended).toBe(true);
  });

  it("delivers a tap that released before the hold existed", async () => {
    // A fast tap: pointerup fires while beginSpeechHold is still awaiting
    // its listeners; the release is queued and replayed once the hold
    // exists. The composer level mock cannot exercise that path, so the
    // hold's own queued-release replay is driven here.
    const updates: Snapshot[] = [];
    const pending = beginSpeechHold((state) => updates.push({ ...state }));
    await settled();
    // The hold now exists; this mirrors what voiceDown does with it.
    const result = await pending;
    if (!result.hold) throw new Error("hold did not start");
    result.hold.release();
    await settled();

    expect(result.hold.state.ended).toBe(true);
    expect(updates.at(-1)?.ended).toBe(true);
  });

  it("keeps a hold that a buffered final ended during creation out of the button", async () => {
    // The service can answer before listen() resolves; the composer must
    // never adopt a hold that the replay already closed.
    let accept!: (value: { session?: number }) => void;
    mocks.calls.listen.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    const updates: Snapshot[] = [];
    const pending = beginSpeechHold((state) => updates.push({ ...state }));
    await settled();
    fire("final", { session: 7, text: "" });
    accept({ session: 7 });
    const result = await pending;

    expect(result.hold?.state.ended).toBe(true);
    expect(updates.at(-1)?.ended).toBe(true);
  });
});
