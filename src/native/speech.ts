import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Dictation through the phone's own recognizer, in-process.
 *
 * Visible only in the Android app: the WebView has no Web Speech API, and a
 * silent no-op would be worse than no button. Unlike the system dialog this
 * streams — partial transcripts and microphone level arrive as events while
 * the person speaks, so the composer can show them.
 *
 * The plugin is a singleton but the composer comes and goes with the chat
 * screen, so every listen() mints a session id; events from another session
 * are dropped here rather than delivered to a stale screen.
 */
interface SpeechEvents {
  ready: { session: number };
  partial: { session: number; text: string };
  final: { session: number; text: string };
  volume: { session: number; value: number };
  recerror: { session: number; error: number };
}

interface SpeechPlugin {
  listen(options: { language?: string }): Promise<{ session?: number; reason?: string }>;
  stop(options?: { session?: number }): Promise<void>;
  cancel(options?: { session?: number }): Promise<void>;
  addListener(
    event: keyof SpeechEvents,
    handler: (data: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<SpeechPlugin>("Speech");

export function speechSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/** Recognizer error codes → what the person is told. */
const ERRORS: Record<number, string> = {
  1: "没听清，再试一次",
  2: "语音服务需要网络，检查网络后重试",
  3: "没能录到声音，检查麦克风后重试",
  4: "语音服务没响应，再试一次",
  5: "手机没有可用的语音服务",
  6: "等太久没有说话",
  7: "没听清，再试一次",
  8: "语音服务忙，稍后再试",
  9: "麦克风权限不足",
};

export const WAVE_BARS = 14;
/** dB → 0..1: 10 dB is a confident voice at phone distance. */
const levelOf = (rms: number): number => Math.max(0, Math.min(1, rms / 10));
/** Slide-up distance that turns a hold into a cancel, in CSS px. */
export const CANCEL_DISTANCE = 64;
/** How long release waits for the service's final result before giving up. */
export const FINISH_WAIT_MS = 15_000;

export interface SpeechSession {
  /** Transcript so far, including everything already final. */
  transcript: string;
  /** Sliding microphone levels, 0..1, oldest first. */
  levels: number[];
  /** The recognizer is up and listening. */
  ready: boolean;
  /** The finger slid far enough up that release will discard the hold. */
  cancelArmed: boolean;
  /** Set once the hold is over, successfully or not. */
  ended: boolean;
  /** What went wrong, in words for the person, when it ended without text. */
  error: string;
}

/**
 * One dictation hold. The composer owns the object; the module keeps the
 * plugin-side single owner so a second screen can never hold the mic twice.
 */
export interface SpeechHold {
  readonly session: number;
  state: SpeechSession;
  /**
   * Finger moved; a net slide past -CANCEL_DISTANCE px arms the cancel,
   * sliding back disarms it.
   */
  move(dy: number): void;
  /** Finger up: an armed hold discards, otherwise stop and await the final. */
  release(): void;
  /** The page went away mid-hold. */
  abandon(): void;
}

type Listener = (state: SpeechSession) => void;

let owner: SpeechHold | null = null;

/**
 * Hold-to-talk dictation.
 *
 * Resolves with the hold once the recognizer is listening. Resolves with
 * `{ hold: null, reason: "denied" }` when the person refused the microphone
 * and `{ hold: null, reason: "no-service" }` when the phone has none — the
 * composer can then point at Settings instead of claiming a dead phone.
 * Events stream into `state` and `onChange`; the hold ends with
 * `state.ended` set and one last `onChange`, carrying `state.error` when
 * it failed.
 */
export async function beginSpeechHold(
  onChange: Listener,
): Promise<{ hold: SpeechHold; reason?: undefined } | { hold: null; reason: "denied" | "no-service" }> {
  if (owner) owner.abandon();

  const state: SpeechSession = {
    transcript: "",
    levels: new Array(WAVE_BARS).fill(0),
    ready: false,
    cancelArmed: false,
    ended: false,
    error: "",
  };

  let session: number | null = null;
  let finished = false;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  // The service can talk the moment listen() resolves — ready and volume
  // events race the resolve itself. Listeners go up first and hold what
  // arrives before the session id is known, then it is replayed.
  const buffered: { event: keyof SpeechEvents; data: Record<string, unknown> }[] = [];

  const finish = (error?: string): void => {
    if (finished) return;
    finished = true;
    if (finishTimer) clearTimeout(finishTimer);
    if (error && !state.error) state.error = error;
    state.ended = true;
    // Harmless after a final result, and the only way to silence the
    // service when the hold ends early.
    void plugin.cancel({ session: session ?? 0 });
    if (owner && owner.session === session) owner = null;
    for (const handle of handles) void handle.remove();
    onChange(state);
  };
  const apply = (event: keyof SpeechEvents, data: Record<string, unknown>): void => {
    switch (event) {
      case "ready":
        state.ready = true;
        break;
      case "partial":
        state.transcript = String(data.text ?? "");
        break;
      case "final":
        state.transcript = String(data.text ?? "");
        // An empty final is the service's way of saying it heard nothing.
        if (!state.transcript) state.error = "没听清，再试一次";
        finish();
        return;
      case "volume":
        state.levels = [...state.levels.slice(1), levelOf(Number(data.value ?? 0))];
        break;
      case "recerror":
        // The service has given up on this attempt either way.
        finish(ERRORS[Number(data.error)] ?? "语音输入出了问题");
        return;
    }
    onChange(state);
  };

  const handles = await Promise.all(
    (Object.keys({
      ready: 0,
      partial: 0,
      final: 0,
      volume: 0,
      recerror: 0,
    }) as (keyof SpeechEvents)[]).map((event) =>
      plugin.addListener(event, (data) => {
        // A session that outlived its screen, or a second screen's, is not
        // ours. Before listen() resolves we cannot tell yet, so it waits.
        if (session === null) {
          buffered.push({ event, data });
          return;
        }
        if (Number(data.session ?? -1) !== session) return;
        if (finished) return;
        apply(event, data);
      }),
    ),
  );

  let started: { session?: number; reason?: string };
  try {
    started = await plugin.listen({ language: navigator.language || "zh-CN" });
  } catch (error) {
    // The bridge itself refused; the listeners are still up and would
    // buffer every event on the phone until the page reloads.
    for (const handle of handles) void handle.remove();
    throw error;
  }
  if (started.session == null) {
    // No recognizer, or a refused prompt. Nothing was delivered for this
    // hold; tear the listeners down and say which it was.
    for (const handle of handles) void handle.remove();
    return { hold: null, reason: started.reason === "denied" ? "denied" : "no-service" };
  }
  session = started.session;
  for (const { event, data } of buffered.splice(0)) {
    if (Number(data.session ?? -1) === session && !finished) apply(event, data);
  }

  const hold: SpeechHold = {
    session,
    state,
    move(dy) {
      if (finished) return;
      const armed = dy < -CANCEL_DISTANCE;
      if (armed !== state.cancelArmed) {
        state.cancelArmed = armed;
        onChange(state);
      }
    },
    release() {
      if (finished) return;
      if (state.cancelArmed) {
        // A cancelled hold discards what was heard; the composer must not
        // find transcript text to append after the fact.
        state.transcript = "";
        finish();
        return;
      }
      // The service never came up: almost always a tap shorter than the
      // recognizer's start latency, or a slide-up that finished while the
      // hold was still being created. Either way the hold is over before
      // it began — ending quietly beats blaming the service.
      if (!state.ready) {
        finish();
        return;
      }
      void plugin.stop({ session });
      finishTimer = setTimeout(() => {
        // The final event is lost; whatever partial text exists is what
        // the person said, and it is still delivered.
        finish();
      }, FINISH_WAIT_MS);
    },
    abandon() {
      finish();
    },
  };
  owner = hold;
  return { hold };
}
