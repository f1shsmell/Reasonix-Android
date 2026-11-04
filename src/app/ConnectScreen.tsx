/**
 * The first screen on a phone: point the app at a kernel.
 *
 * A QR code carries either a LAN origin with a one-time pairing code, or the
 * Internet link. The pairing is spent by the loopback proxy, so the app never
 * puts the code in a URL and the device cookie lands on the app's own origin.
 * Account sign-in uses the device flow: a short code approved in the phone's
 * browser, with the session token kept by the proxy.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { onNetworkChange } from "../native/networkWatch";
import { Browser } from "@capacitor/browser";
import { Clipboard } from "@capacitor/clipboard";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerScanOrientation,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import {
  clearRelay,
  configureProxy,
  listRemoteDevices,
  markRelay,
  parseServerLink,
  pollAccount,
  probeUpstream,
  readMachineIdentity,
  readProxyConfig,
  signInAccount,
  signOutAccount,
  startAccount,
  approveDevice,
  ProxyError,
} from "../net/server";
import type { DeviceGrant, ProxyAccount, ProxyConfig, RemoteDevice, ServerLink } from "../net/server";
import { disconnectProxy, setNetworkPolicy, studioWebUrl } from "../net/server";
import { linkFailure } from "../net/link";
import type { LinkError, LinkState } from "../net/link";
import { ConnectionHero } from "./ConnectionHero";
import { useBackCloser } from "./backStack";
import { clearRelayRouting, connectRelay, RelayError } from "../net/relay";
import { forgetDevice } from "../net/deviceTrust";
import type { TrustPrompt } from "../net/deviceTrust";
import { clearRelayDevice, loadRelayDevice } from "../net/relayStore";
import {
  connectionKey,
  directDoorForMachine,
  forgetCloudConnections,
  forgetConnection,
  groupConnections,
  learnConnectionMachine,
  loadConnections,
  machineKey,
  moveConnectionGroup,
  normalizeTarget,
  rememberConnection,
} from "../net/savedConnections";
import type { ConnectionGroup, SavedConnection } from "../net/savedConnections";
import { dragShift, dropEdge, useRowDrag } from "./useRowDrag";
import { RequestTimeout, withTimeout } from "../net/http";
import { forgetFleetPeer } from "../net/fleet";
import { NativeLogin } from "../native/login";
import { NativePair } from "../native/pair";
import type { PairResult } from "../native/pair";
import { WebMode } from "../native/webmode";
import {
  loadBackgroundStatus,
  openBatterySettings,
  openNotificationSettings,
} from "../native/turn";
import type { BackgroundStatus } from "../native/turn";
import { THEME_CHOICES, applyTheme, loadTheme, saveTheme } from "./theme";
import type { ThemeChoice } from "./theme";
import { hapticSample, loadSurfaceChoice, loadHaptics, saveHapticSurface, saveHaptics } from "./haptics";
import { Switch } from "./Switch";
import { FOLD_CHOICES, loadFoldMode, saveFoldMode } from "../chat/folding";
import type { FoldMode } from "../chat/folding";
import { CHAT_FONT_CHOICES, applyChatFont, loadChatFont, saveChatFont } from "../chat/chatFont";
import type { ChatFont } from "../chat/chatFont";
import { NET_POLICY_CHOICES, loadNetPolicy, saveNetPolicy } from "./netpref";
import type { NetPolicy } from "./netpref";
import { ENTER_CHOICES, loadEnterPref, saveEnterPref } from "./enterPref";
import type { EnterPref } from "./enterPref";
import { Segmented } from "./Segmented";
import type { NotificationPrefs } from "./notifyPref";
import { swipeDirection } from "./swipe";
import { useUpdater } from "./useUpdater";
import { UpdateRow } from "./UpdateRow";

export interface ConnectScreenProps {
  onConnected: () => void;
  /** The upstream was switched but the kernel did not answer through it. */
  onFailed?: (error: LinkError) => void;
  /** The person disconnected on purpose; the link machine stands down. */
  onDisconnected?: () => void;
  /** Present when this screen was opened over an existing connection. */
  onClose?: () => void;
  /** The app's link machine, for the hero at the top of the page. */
  link?: LinkState;
  /** Cloud background reminders, owned by App because the service follows the link. */
  cloudWatch?: boolean;
  onCloudWatchChange?: (on: boolean) => void;
  /** Inline ask options in the notification; off means one 去回答 action. */
  notificationOptions?: boolean;
  onNotificationOptionsChange?: (on: boolean) => void;
  /** Which notification surfaces post, and whether ask interrupts. */
  notifyPrefs?: NotificationPrefs;
  onNotifyPrefChange?: (name: keyof NotificationPrefs, on: boolean) => void;
  /** The About page's copy-diagnostics text, built by App from its live state. */
  buildDiagnostics?: () => Promise<string>;
}

/**
 * Why a device code could not be fetched.
 *
 * A timeout is the common one on phones: the proxy's connect timeout matches
 * the old request deadline, so a stalled IPv6 route looked exactly like an
 * unanswered tap. The sentence names the service so the next step (another
 * network) is obvious instead of another retry on the same one.
 */
function signInFailureText(failure: unknown): string {
  if (failure instanceof RequestTimeout) {
    return "登录服务没有响应。手机可能连不上 id.reasonix.io：换 Wi‑Fi/流量，或先关掉 VPN、组网（如蒲公英）再试。";
  }
  if (failure instanceof ProxyError) {
    if (failure.code === "proxy.upstream_unreachable") {
      return "手机连不上登录服务 id.reasonix.io。检查网络，或先关掉 VPN、组网后再试。";
    }
    return `登录服务不可用：${failure.code}`;
  }
  return failure instanceof Error ? `登录服务不可用：${failure.message}` : "登录服务不可用";
}

/** The three settings panes, in swipe order. */
const PANE_OPTIONS = [
  { value: "connect", label: "电脑" },
  { value: "account", label: "账号" },
  { value: "prefs", label: "偏好" },
] as const;

/**
 * How long to wait for the hidden pairing page.
 *
 * `PairActivity` gives up at 15 s, so this only has to clear that with room
 * for the round trip back through the plugin. It exists because the activity's
 * answer is not guaranteed to arrive at all: the callback that carries it holds
 * a `PluginCall`, and a rebuilt activity or a reloaded WebView leaves that call
 * dead — the plugin then returns without settling and the promise never
 * resolves. Without a deadline of its own the screen would spin forever.
 */
const PAIR_DEADLINE_MS = 20_000;

type Pane = (typeof PANE_OPTIONS)[number]["value"];

/** A typed refusal is an identity; only an unknown error has no code. */
function refusalCode(failure: unknown): string {
  if (failure instanceof ProxyError) return failure.code;
  return failure instanceof Error ? failure.message : "unknown";
}

/** A refusal from the identity service while signing in or approving. */
function accountFailureText(failure: unknown): string {
  // An unreachable service has its own sentence; a reply from it does not.
  if (failure instanceof ProxyError && failure.code !== "proxy.upstream_unreachable") {
    switch (failure.code) {
      case "invalid_credentials":
        return "邮箱或密码不正确。";
      case "account_unavailable":
        return "这个账号当前不可用，请在网页里查看账号状态。";
      case "account.signin_required":
        return "登录状态没有建立，请在网页中重新登录。";
      case "invalid_user_code":
        return "登录码已失效，请取消后重新点登录。";
      case "account.missing_credentials":
        return "先填邮箱和密码。";
      default:
        break;
    }
    if (failure.status === 429) return "尝试太频繁，等一分钟再试。";
    if (failure.status === 403) return "登录服务拒绝了这次请求，可能被网络或代理拦截。";
    if (failure.status >= 500) return "登录服务暂时不可用，稍后再试。";
  }
  return signInFailureText(failure);
}

export function ConnectScreen({ onConnected, onFailed, onDisconnected, onClose, link, cloudWatch, onCloudWatchChange, notificationOptions, onNotificationOptionsChange, notifyPrefs, onNotifyPrefChange, buildDiagnostics }: ConnectScreenProps) {
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [origin, setOrigin] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [account, setAccount] = useState<ProxyAccount>({ signedIn: false });
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [grant, setGrant] = useState<DeviceGrant | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /** Sign-in stays in its own notice: the shared one sits above the fold. */
  const [signInError, setSignInError] = useState("");
  /** The native sign-in form: the fast path that skips the slow web page. */
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountBusy, setAccountBusy] = useState("");
  /** The device code is approved; the poll behind this screen is finishing. */
  const [approved, setApproved] = useState(false);
  const [theme, setThemeState] = useState<ThemeChoice>(() => loadTheme());
  const [fold, setFold] = useState<FoldMode>(() => loadFoldMode());
  /** The transcript's reading text size; applied to the root like the theme. */
  const [chatFont, setChatFont] = useState<ChatFont>(() => loadChatFont());
  /** Which half of settings is showing: the computer, or this phone. */
  const [pane, setPane] = useState<Pane>("connect");
  /** The About row: check for a release while the phone's preferences are open. */
  const updater = useUpdater(pane === "prefs");
  /** The direction the pane arrived from, so the slide reads as movement. */
  const [paneDir, setPaneDir] = useState<"none" | "forward" | "back">("none");
  /** How the proxy reaches a LAN computer while a VPN is active. */
  const [netPolicy, setNetPolicyState] = useState<NetPolicy>(() => loadNetPolicy());
  /** What Enter does in the composer: send, or a line break for hardware keyboards. */
  const [enterPref, setEnterPrefState] = useState<EnterPref>(() => loadEnterPref());
  /** Whether held rows, picked-up projects and streamed answers buzz. */
  const [haptics, setHapticsState] = useState(() => loadHaptics());
  /** Gesture feedback: a long press arming, a row being picked up and dropped. */
  const [hapticDrag, setHapticDragState] = useState(() => loadSurfaceChoice("drag"));
  /** Stream feedback: the two edges of an answer, not the text between them. */
  const [hapticStream, setHapticStreamState] = useState(() => loadSurfaceChoice("stream"));
  /** The copy-diagnostics row's last result. */
  const [diagStatus, setDiagStatus] = useState("");
  /** Computers this phone has connected to before, newest first. */
  const [saved, setSaved] = useState<SavedConnection[]>(() => loadConnections());
  /** What the system allows in the background; null where it cannot answer. */
  const [background, setBackground] = useState<BackgroundStatus | null>(null);
  /** The first cloud connection to a device waits here for the person. */
  const [trustAsk, setTrustAsk] = useState<TrustPrompt | null>(null);
  /** The device whose pin no longer matches; the error offers to start over. */
  const [retrust, setRetrust] = useState<string | null>(null);
  /** What a manual attempt is aiming at, before the proxy has switched. */
  const [pending, setPending] = useState<{ kind: "lan" | "cloud"; name: string } | null>(null);
  const trustResolve = useRef<((accepted: boolean) => void) | null>(null);
  /** The scroll container; switching panes starts at the top, not mid-page. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Where a touch began, for the sideways swipe between panes. */
  const paneTouch = useRef<{ x: number; y: number; owned: boolean } | null>(null);

  const choosePane = useCallback(
    (next: Pane) => {
      if (next === pane) return;
      const from = PANE_OPTIONS.findIndex((option) => option.value === pane);
      const to = PANE_OPTIONS.findIndex((option) => option.value === next);
      // Reset before the new pane paints, so the slide starts at its top.
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setPaneDir(to > from ? "forward" : "back");
      setPane(next);
    },
    [pane],
  );

  /**
   * A sideways drag between settings panes.
   *
   * The drag is judged on release, after the vertical scroll has had its
   * chance, so a list flick never changes pane. A touch that began in a text
   * field or on a sheet belongs to that control, not to the page.
   */
  const onPaneTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    // A fresh gesture is never the tail of a drag, so the flag a finished drag
    // leaves behind is cleared here rather than inside the hook.
    savedDrag.swallowSwipe.current = false;
    const start = event.touches[0];
    if (!start) return;
    const target = event.target as Element | null;
    const owned =
      target !== null && typeof target.closest === "function"
        ? target.closest("input, textarea, select, .sheet-backdrop") !== null
        : false;
    paneTouch.current = { x: start.clientX, y: start.clientY, owned };
  };

  const onPaneTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = paneTouch.current;
    paneTouch.current = null;
    // A drag that reordered the saved list ends with the same `touchend` a
    // sideways pane swipe would: letting it through would switch panes while
    // the person was arranging their computers.
    if (savedDrag.swallowSwipe.current) {
      savedDrag.swallowSwipe.current = false;
      return;
    }
    if (!start || start.owned) return;
    const end = event.changedTouches[0];
    if (!end) return;
    const direction = swipeDirection({
      startX: start.x,
      startY: start.y,
      endX: end.clientX,
      endY: end.clientY,
    });
    if (direction === 0) return;
    const index = PANE_OPTIONS.findIndex((option) => option.value === pane);
    const next = PANE_OPTIONS[index + direction];
    if (next) choosePane(next.value);
  };

  const confirmTrust = useCallback(
    (prompt: TrustPrompt) =>
      new Promise<boolean>((resolve) => {
        trustResolve.current?.(false);
        trustResolve.current = resolve;
        setTrustAsk(prompt);
      }),
    [],
  );

  const settleTrust = useCallback((accepted: boolean) => {
    const resolve = trustResolve.current;
    trustResolve.current = null;
    setTrustAsk(null);
    resolve?.(accepted);
  }, []);

  const cancelTrust = useCallback(() => settleTrust(false), [settleTrust]);
  useBackCloser(trustAsk !== null, cancelTrust);

  // A connection attempt waiting on a person must not outlive the screen.
  useEffect(
    () => () => {
      trustResolve.current?.(false);
      trustResolve.current = null;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void readProxyConfig().then((next) => {
      if (cancelled || next === null) return;
      setConfig(next);
      setAccount(next.account);
      setOrigin(next.origin);
      // A connection made before this list existed, or by recovery, is still
      // a place worth returning to.
      if (next.mode === "relay" && next.relayDevice) {
        setSaved(rememberConnection("cloud", next.relayDevice));
      } else if (next.origin) {
        setSaved(rememberConnection("lan", next.origin));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A LAN door is saved before the far side has said its name. Ask each one
  // once, so a cloud device and its LAN origin can be drawn as one computer.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    const unknown = loadConnections().filter(
      (entry) => entry.kind === "lan" && !entry.machine,
    );
    if (unknown.length === 0) return;
    void Promise.all(
      unknown.map(async (entry) => ({
        target: entry.target,
        identity: await readMachineIdentity(entry.target),
      })),
    ).then((answers) => {
      if (cancelled) return;
      let learned = false;
      for (const answer of answers) {
        if (!answer.identity) continue;
        learnConnectionMachine("lan", answer.target, answer.identity.machine);
        learned = true;
      }
      if (learned) setSaved(loadConnections());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The account names each cloud device; recording that name is what lets a
  // saved LAN row and this device be recognised as one computer.
  useEffect(() => {
    if (devices.length === 0) return;
    let learned = false;
    for (const row of loadConnections()) {
      if (row.kind !== "cloud") continue;
      const machine = devices.find((device) => device.id === row.target)?.name?.trim();
      if (!machine || machineKey(row.machine) === machineKey(machine)) continue;
      learnConnectionMachine("cloud", row.target, machine);
      learned = true;
    }
    if (learned) setSaved(loadConnections());
  }, [devices]);

  const refreshBackground = useCallback(() => {
    void loadBackgroundStatus().then((next) => {
      if (next !== null) setBackground(next);
    });
  }, []);

  useEffect(() => {
    refreshBackground();
  }, [refreshBackground]);

  // The two rows below open system pages, so their values go stale while the
  // app is paused; rereading on resume is what makes the return trip honest.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void NativeApp.addListener("appStateChange", (state) => {
      if (state.isActive) refreshBackground();
    }).then((handle) => {
      if (cancelled) {
        void handle.remove();
        return;
      }
      remove = () => {
        void handle.remove();
      };
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [refreshBackground]);

  const pickTheme = useCallback((choice: ThemeChoice) => {
    setThemeState(choice);
    saveTheme(choice);
    applyTheme(choice);
  }, []);

  const pickFold = useCallback((mode: FoldMode) => {
    setFold(mode);
    saveFoldMode(mode);
  }, []);

  const pickChatFont = useCallback((font: ChatFont) => {
    setChatFont(font);
    saveChatFont(font);
    applyChatFont(font);
  }, []);

  const pickNetPolicy = useCallback((policy: NetPolicy) => {
    setNetPolicyState(policy);
    saveNetPolicy(policy);
    // The proxy is the enforcer; the local store only remembers the choice.
    // An old native build has no route for this and the tap still sticks.
    void setNetworkPolicy(policy).catch(() => {});
  }, []);

  const pickEnterPref = useCallback((pref: EnterPref) => {
    setEnterPrefState(pref);
    saveEnterPref(pref);
  }, []);

  const pickHaptics = useCallback((enabled: boolean) => {
    setHapticsState(enabled);
    saveHaptics(enabled);
    // Turning it on is the one moment a sample is useful: it proves the
    // switch reached the device. It bypasses the per-surface switches, or
    // turning on a master whose sub-switches are all off would look broken.
    if (enabled) void hapticSample();
  }, []);

  const pickHapticDrag = useCallback((enabled: boolean) => {
    setHapticDragState(enabled);
    saveHapticSurface("drag", enabled);
  }, []);

  const pickHapticStream = useCallback((enabled: boolean) => {
    setHapticStreamState(enabled);
    saveHapticSurface("stream", enabled);
  }, []);

  const connect = useCallback(
    async (target: string, code: string) => {
      const base = target.trim().replace(/\/+$/, "");
      const pairCodeValue = code.trim();
      if (!base) {
        setError("先填一个地址，或者扫码。");
        return;
      }
      const viaWeb = Capacitor.isNativePlatform() && pairCodeValue !== "";
      setBusy(viaWeb ? "正在配对" : "正在连接");
      setError("");
      setPending({ kind: "lan", name: base });
      const previous = config;
      /** Put the working LAN upstream back when the new one cannot be read. */
      const restore = async (attempted: ProxyConfig): Promise<boolean> => {
        if (previous === null || previous.mode === "relay" || !previous.origin) return false;
        if (normalizeTarget("lan", previous.origin) === normalizeTarget("lan", attempted.origin)) {
          return false;
        }
        try {
          const back = await configureProxy(previous.origin);
          setConfig(back);
          setAccount(back.account);
          setOrigin(back.origin);
          // Switching back is not proof the old computer still answers; only
          // then may the link machine stay out of its failed state.
          return (await probeUpstream()).ok;
        } catch {
          // The old address remains a hint; the attempt's error is what to show.
          return false;
        }
      };
      const apply = async (next: ProxyConfig): Promise<boolean> => {
        // Only after the new LAN upstream is saved: a failed attempt must
        // leave an existing relay connection alone.
        clearRelayRouting();
        setConfig(next);
        setAccount(next.account);
        setOrigin(next.origin);
        // The proxy now has an address; that is not the same as a kernel.
        // Read the conversation list before calling this a connection, so a
        // dead address is refused here instead of on the home screen.
        setBusy("正在读取会话");
        const reach = await probeUpstream();
        if (!reach.ok) {
          const failure = linkFailure(reach.code);
          // A restored upstream is still a live link; only an attempt that
          // left the phone nowhere belongs in the link machine's failed state.
          if (!(await restore(next))) onFailed?.(failure);
          setError(
            `连上了地址，但读不到会话：${failure.message}` +
              (previous?.vpn ? " 检测到 VPN/代理，可在「电脑」页改代理策略。" : ""),
          );
          return false;
        }
        setPairCode("");
        if (next.origin) setSaved(rememberConnection("lan", next.origin));
        onConnected();
        return true;
      };
      try {
        if (viaWeb) {
          let outcome: PairResult = { paired: false, reason: "unavailable" };
          try {
            // The Studio page's own #pair bootstrap is the path a browser
            // uses; the hidden WebView runs it and leaves its cookie for the
            // proxy. The direct POST /pair below is only the fallback.
            //
            // The deadline is the shell's, not the page's: `PairActivity`
            // gives up after 15 s, but its result only reaches us if the
            // plugin's callback still holds a live `PluginCall`. When the
            // activity is rebuilt or the WebView reloads, that call is gone
            // and the plugin returns without settling — so without a deadline
            // here the promise never resolves, `connect`'s `finally` never
            // runs, and the button sits on "正在配对" forever. Timing out is
            // not a failure: the cookie may already have landed, which is why
            // the exchange below still runs.
            //
            // A result that arrives after the deadline is dropped, not
            // adopted: `withTimeout` has already settled the race by then, and
            // the activity that would have produced it has been abandoned.
            // Nothing is lost in practice — the page's own timeout is five
            // seconds shorter, so a late answer only means the callback died.
            outcome = await withTimeout(
              NativePair.pair({
                url: `${base}/#pair=${encodeURIComponent(pairCodeValue)}`,
                origin: base,
              }),
              PAIR_DEADLINE_MS,
            );
          } catch {
            // The activity did not answer; the exchange below can still pair.
          }
          if (outcome.paired) {
            await apply(await configureProxy(base));
            return;
          }
          if (outcome.reason === "cancelled") {
            // Closing the sheet is a choice, not a failed pairing.
            setError("");
            return;
          }
          // The hidden page can fail without spending the code: an older
          // share page has no #pair bootstrap, and a slow cookie is not a
          // refusal. Let the exchange itself decide.
          try {
            if (await apply(await configureProxy(base, pairCodeValue))) return;
            return;
          } catch (failure) {
            // A code the page already spent answers 403. Its cookie may
            // still have landed, in which case the kernel can answer.
            if (refusalCode(failure) === "device.pairing_invalid") {
              try {
                if (await apply(await configureProxy(base))) return;
              } catch {
                // Report the refusal below; it names the next step.
              }
            }
            throw failure;
          }
        }
        await apply(await configureProxy(base, pairCodeValue || undefined));
      } catch (failure) {
        const failureCode = refusalCode(failure);
        const where = base;
        if (failureCode === "device.pairing_invalid") {
          setError(
            `配对码已失效（地址 ${where}，App 用的码 ${pairCodeValue || "(空)"}）。` +
              "请在电脑上点「换一个」生成新码后重新扫码；在浏览器里打开过的码已经用完。",
          );
          // A refused code cannot answer a retry; asking again needs a new one.
          setPairCode("");
        } else if (failureCode === "device.pair_route_missing") {
          setError(`这个地址不是局域网配对端口（${where}）。请用二维码里的地址，不要手填 8791。`);
          setPairCode("");
        } else if (failureCode === "device.pair_unreachable" || failureCode === "proxy.upstream_unreachable") {
          // A network failure does not spend the code; keep it for the retry.
          setError(
            "到不了这台电脑：确认在同一 Wi-Fi，且用二维码里的地址。" +
              (previous?.vpn ? " 检测到 VPN/代理，可在「电脑」页改代理策略。" : ""),
          );
        } else {
          setError(`没连上：${failureCode}`);
        }
      } finally {
        setBusy("");
        setPending(null);
      }
    },
    [config, onConnected, onFailed],
  );

  const connectCloud = useCallback(
    async (deviceId: string) => {
      const target = devices.find((device) => device.id === deviceId);
      if (target && Array.isArray(target.capabilities) && !target.capabilities.includes("desktop")) {
        setError("这台电脑未开启「互联网远程访问」，去电脑 Studio 的「设备访问」打开后再试。");
        return;
      }
      setBusy("正在连接云端");
      setError("");
      setRetrust(null);
      setPending({ kind: "cloud", name: target?.name ?? target?.id ?? deviceId });
      // The link's progress and its errors are drawn on the computer pane;
      // the tap happened on the account pane, so follow the attempt back.
      setPane("connect");
      let link: Awaited<ReturnType<typeof connectRelay>> | null = null;
      try {
        link = await connectRelay(deviceId, { confirm: confirmTrust });
        const next = await markRelay(deviceId);
        setConfig(next);
        setAccount(next.account);
        // The handshake says the relay opened; it does not say the computer
        // is still there. Ask the kernel through it before switching screens.
        setBusy("正在读取会话");
        const reach = await probeUpstream();
        if (!reach.ok) {
          clearRelayRouting();
          const failure = linkFailure(reach.code);
          onFailed?.(failure);
          setError(`云端通道已打开，但读不到会话：${failure.message}`);
          return;
        }
        setSaved(
          rememberConnection("cloud", deviceId, target?.name, target?.name),
        );
        onConnected();
      } catch (failure) {
        // `connectRelay` only replaces the active link after its handshake
        // succeeds. If it threw, `link` is null and an existing relay must be
        // left alone; otherwise remove the link that did replace it.
        if (link !== null) clearRelayRouting();
        if (failure instanceof RelayError && failure.kind === "reauth") {
          setError("登录已过期，请重新登录 Reasonix 账号。");
        } else if (failure instanceof RelayError && failure.kind === "trust_cancelled") {
          // The sheet was closed on purpose; an error banner would read as a
          // fault rather than as the choice the person just made.
          setError("");
        } else if (failure instanceof RelayError && failure.kind === "trust_changed") {
          setError(failure.message);
          setRetrust(deviceId);
        } else if (failure instanceof RelayError && failure.kind.startsWith("trust_")) {
          setError(failure.message);
        } else {
          setError(failure instanceof Error ? `云端连接没建立：${failure.message}` : "云端连接没建立");
        }
      } finally {
        setBusy("");
        setPending(null);
      }
    },
    [confirmTrust, devices, onConnected, onFailed],
  );

  const applyLink = useCallback(
    async (link: ServerLink) => {
      if (link.kind === "cloud") {
        if (!account.signedIn) {
          setError("这是互联网连接码。先登录 Reasonix 账号，再用它连接。");
          return;
        }
        await connectCloud(link.device);
        return;
      }
      setOrigin(link.origin);
      setPairCode(link.pairCode ?? "");
      await connect(link.origin, link.pairCode ?? "");
    },
    [account.signedIn, connect, connectCloud],
  );

  const scan = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) {
      setError("扫码只在 Android 应用里可用；浏览器里请填地址。");
      return;
    }
    setBusy("正在打开相机");
    setError("");
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        // A Studio code is always a QR code. Asking for every symbology makes
        // the detector do needless work per frame and is the main reason the
        // first read felt slow; MLKit's QR-only path is the fast one.
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "对准二维码，慢的话点手电筒",
        cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
        scanOrientation: CapacitorBarcodeScannerScanOrientation.ADAPTIVE,
        android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.MLKIT },
      });
      const link = parseServerLink(result.ScanResult);
      if (!link) {
        setError("这个二维码里没有连接信息。");
        return;
      }
      await applyLink(link);
    } catch (failure) {
      setError(failure instanceof Error ? `扫码没完成：${failure.message}` : "扫码没完成");
    } finally {
      setBusy("");
    }
  }, [applyLink]);

  const pasteLink = useCallback(async () => {
    setError("");
    try {
      const { value } = await Clipboard.read();
      const link = parseServerLink(value);
      if (!link) {
        setError("剪贴板里没有连接链接。请复制浏览器地址栏里的完整 URL。");
        return;
      }
      await applyLink(link);
    } catch (failure) {
      setError(failure instanceof Error ? `读取剪贴板失败：${failure.message}` : "读取剪贴板失败");
    }
  }, [applyLink]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void NativeApp.addListener("appUrlOpen", (event) => {
      const link = parseServerLink(event.url);
      if (link) void applyLink(link);
    }).then((handle) => {
      if (cancelled) {
        void handle.remove();
        return;
      }
      remove = () => {
        void handle.remove();
      };
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [applyLink]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void onNetworkChange((status) => {
      if (!status.connected) return;
      // Read, do not refresh: `/refresh` probes the remembered origins and
      // may re-point the proxy at another computer. Choosing a door belongs to
      // the link machine, which verifies it and updates the target; this screen
      // only keeps its copy of the ordered candidates current.
      void readProxyConfig().then((next) => {
        if (next === null) return;
        setConfig(next);
        setAccount(next.account);
        setOrigin(next.origin);
      });
    }).then((handle) => {
      if (cancelled) {
        void handle?.remove();
        return;
      }
      remove = () => {
        void handle?.remove();
      };
    });
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  const openLoginPage = useCallback((url: string) => {
    const failed = (failure: unknown) => {
      setSignInError(
        failure instanceof Error
          ? `打不开登录页：${failure.message}`
          : "打不开登录页，请重试。",
      );
    };
    if (Capacitor.isNativePlatform()) {
      void NativeLogin.open({ url }).catch(() => Browser.open({ url }).catch(failed));
    } else {
      void Browser.open({ url }).catch(failed);
    }
  }, []);

  const signIn = useCallback(async () => {
    setBusy("正在获取登录码");
    setError("");
    setSignInError("");
    setApproved(false);
    try {
      const next = await startAccount();
      setGrant(next);
    } catch (failure) {
      setSignInError(signInFailureText(failure));
    } finally {
      setBusy("");
    }
  }, []);

  /**
   * Sign in without the web page.
   *
   * The password goes to the loopback proxy, which sends it once to the
   * identity service; the form then approves the code the app just asked for.
   * The web page is kept for registration, verification and password resets.
   */
  const nativeSignIn = useCallback(async () => {
    if (!grant) return;
    const mail = email.trim();
    if (!mail || password === "") {
      setSignInError("先填邮箱和密码。");
      return;
    }
    setAccountBusy("正在登录");
    setSignInError("");
    try {
      await signInAccount(mail, password);
      setAccountBusy("正在批准");
      await approveDevice(grant.userCode);
      setPassword("");
      setApproved(true);
    } catch (failure) {
      setSignInError(accountFailureText(failure));
    } finally {
      setAccountBusy("");
    }
  }, [email, grant, password]);

  const cancelGrant = useCallback(() => {
    setGrant(null);
    setApproved(false);
    setPassword("");
    setSignInError("");
  }, []);

  useEffect(() => {
    if (grant === null) return;
    let cancelled = false;
    let timer = 0;
    const lifetime = Number.isFinite(grant.expiresIn) ? grant.expiresIn : 600;
    const deadline = Date.now() + Math.max(1, lifetime) * 1000;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setGrant(null);
        setApproved(false);
        setSignInError("登录码已过期，请重新登录。");
        return;
      }
      try {
        const result = await pollAccount(grant.deviceCode);
        if (cancelled) return;
        if (result.status === "complete") {
          setGrant(null);
          setApproved(false);
          setPassword("");
          setSignInError("");
          setAccount({ signedIn: true, ...(result.user ? { user: result.user } : {}) });
          return;
        }
        if (result.status === "ended" || result.status === "error") {
          setGrant(null);
          setApproved(false);
          setSignInError(result.status === "ended" ? "登录已取消或过期。" : "登录失败，请重试。");
          return;
        }
        timer = window.setTimeout(() => void tick(), Math.max(1, grant.interval) * 1000);
      } catch {
        timer = window.setTimeout(() => void tick(), 5000);
      }
    };
    timer = window.setTimeout(() => void tick(), Math.max(1, grant.interval) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [grant]);

  useEffect(() => {
    if (!account.signedIn) {
      setDevices([]);
      return;
    }
    let cancelled = false;
    void listRemoteDevices()
      .then((next) => {
        if (!cancelled) setDevices(next);
      })
      .catch(() => {
        if (!cancelled) setDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [account.signedIn]);

  /**
   * Drop the active upstream without touching the saved rows: the phone goes
   * offline by choice, and reconnecting is a tap on a remembered computer.
   */
  /**
   * Drop the active upstream without touching the saved rows: the phone goes
   * offline by choice, and reconnecting is a tap on a remembered computer.
   *
   * The proxy is asked first. Tearing the web-side relay down before the
   * POST answers would kill a live connection on a failure — an old shell
   * that does not know the route — and the native proxy would keep
   * forwarding without anyone being told.
   */
  const disconnect = useCallback(async () => {
    setError("");
    try {
      const next = await disconnectProxy();
      clearRelayRouting();
      clearRelayDevice();
      setOrigin("");
      setConfig(next);
      onDisconnected?.();
    } catch (failure) {
      setError(`没断开：${refusalCode(failure)}`);
    }
  }, [onDisconnected]);

  /**
   * Forget one door: this address, not the whole computer.
   *
   * A computer can hold several doors — a LAN origin and a cloud id, or two
   * addresses on different subnets — and they are not interchangeable: one may
   * be a stale port while the other still answers. Removing the computer
   * because one address went bad is how a working route gets lost.
   *
   * The side effects belong to the door being removed: the cloud identity is
   * what a reinstall has to clear, and the fleet watch is spent per target.
   */
  const forgetDoor = useCallback((row: SavedConnection) => {
    if (row.kind === "cloud") forgetDevice(row.target);
    void forgetFleetPeer(row.kind, row.target).catch(() => {});
    setSaved(forgetConnection(row.kind, row.target));
  }, []);

  const signOut = useCallback(async () => {
    setSignInError("");
    const cloudRows = loadConnections().filter((entry) => entry.kind === "cloud");
    try {
      setAccount(await signOutAccount());
      setDevices([]);
      clearRelayRouting();
      clearRelayDevice();
      await clearRelay();
      // Cloud rows name devices this account can no longer reach; the LAN
      // ones are still places this phone may connect without an account.
      setSaved(forgetCloudConnections());
      for (const row of cloudRows) {
        void forgetFleetPeer("cloud", row.target).catch(() => {});
      }
    } catch (failure) {
      setError(failure instanceof Error ? `退出失败：${failure.message}` : "退出失败");
    }
  }, []);

  /**
   * Switch to a recorded computer.
   *
   * A cloud row needs the account it was recorded under; a LAN row uses the
   * pairing the proxy already holds, so no code is asked for again.
   */
  const switchTo = useCallback(
    async (entry: SavedConnection) => {
      if (busy) return;
      if (entry.kind === "cloud") {
        if (!account.signedIn) {
          setError("这台电脑走云端连接。先登录 Reasonix 账号，再点它。");
          return;
        }
        await connectCloud(entry.target);
        return;
      }
      await connect(entry.target, "");
    },
    [account.signedIn, busy, connect, connectCloud],
  );

  const current = useCallback(
    (entry: SavedConnection): boolean => {
      if (!config) return false;
      if (entry.kind === "cloud") {
        return config.mode === "relay" && config.relayDevice === entry.target;
      }
      return config.mode !== "relay" && normalizeTarget("lan", config.origin) === entry.target;
    },
    [config],
  );

  const known = config?.origin ?? "";
  /**
   * The addresses this phone can reach without going through a tunnel.
   *
   * A computer exposing both its Wi-Fi address and a mesh-VPN one is two rows
   * in the list above, and they are not equally good. Naming the direct one
   * is what lets a person pick it on purpose instead of by experiment.
   */
  const direct = config?.direct ?? [];
  const labelOf = (entry: SavedConnection): string =>
    entry.kind === "cloud"
      ? (devices.find((device) => device.id === entry.target)?.name ?? entry.name)
      : entry.name;
  const currentEntry = saved.find((entry) => current(entry)) ?? null;

  /** One row per computer: a named LAN origin and cloud device share a row. */
  const groups = groupConnections(saved);
  const groupHere = (group: ConnectionGroup): boolean => group.rows.some(current);
  /** The door a tap takes: direct LAN, then LAN, then cloud, then the rest. */
  const groupDoor = (group: ConnectionGroup): SavedConnection => {
    const here = group.rows.find(current);
    if (here) return here;
    const near = group.machine
      ? directDoorForMachine(group.rows, group.machine, direct)
      : null;
    if (near) return near;
    return (
      group.rows.find((row) => row.kind === "lan") ??
      group.rows.find((row) => row.kind === "cloud") ??
      group.rows[0]!
    );
  };
  const groupLabel = (group: ConnectionGroup, door: SavedConnection): string =>
    group.machine || labelOf(door);
  /**
   * One door, named so two doors of one computer can be told apart.
   *
   * The group's own detail line summarises the whole computer ("局域网 · 云端"),
   * which is right for the row a tap takes. Under it, each door has to say
   * which route it is and where it points, or the × beside it would be a guess.
   */
  const doorDetail = (door: SavedConnection): string => {
    if (door.kind === "cloud") return "云端 · Reasonix 账号";
    const near = direct.some((origin) => normalizeTarget("lan", origin) === door.target);
    return `局域网 · ${door.target}${near ? " · 可直连" : ""}`;
  };
  /** A door's own name, for the row under a computer. */
  const doorLabel = (door: SavedConnection): string => labelOf(door);
  const groupDetail = (group: ConnectionGroup, door: SavedConnection): string => {
    const kinds = new Set(group.rows.map((row) => row.kind));
    const both = kinds.has("lan") && kinds.has("cloud");
    const transport = both
      ? "局域网 · 云端"
      : door.kind === "lan"
        ? `局域网 · ${door.target}`
        : "云端 · Reasonix 账号";
    const near = group.rows.some(
      (row) =>
        row.kind === "lan" &&
        direct.some((origin) => normalizeTarget("lan", origin) === row.target),
    );
    return near ? `${transport} · 可直连` : transport;
  };

  /**
   * The saved list is also the retry order, so it is rearranged here as well
   * as in 切换连接. Both write the same record; whichever is open shows the
   * order the next reconnect will walk. One computer moves as a block: its
   * two doors must stay together or the next walk could split them.
   */
  const savedDrag = useRowDrag<HTMLElement>({
    rows: groups.map((group) => ({
      key: group.key,
      movable: true,
    })),
    enabled: busy === "" && pane === "connect",
    scrollerSelector: ".connect",
    place: (key, index) => setSaved(moveConnectionGroup(key, index)),
  });
  const relayName =
    config?.mode === "relay" && config.relayDevice
      ? devices.find((device) => device.id === config.relayDevice)?.name
      : undefined;
  const spare = config ? config.candidates.length - 1 : 0;
  const connectedName =
    config?.mode === "relay"
      ? (relayName ?? currentEntry?.name ?? "云端电脑")
      : known || currentEntry?.name || "连接你的电脑";
  const connectedDetail =
    config?.mode === "relay"
      ? "云端 · Reasonix 账号"
      : known
        ? (spare > 0 ? `局域网 · 还有 ${spare} 个备用地址` : "局域网直连")
        : "扫码、粘贴链接，或登录账号";
  const heroName = pending?.name ?? connectedName;
  const heroDetail =
    pending === null
      ? connectedDetail
      : pending.kind === "cloud"
        ? "云端 · Reasonix 账号"
        : "局域网";
  /** The computer's own Studio page, for opening the full desktop UI. */
  const webUrl = studioWebUrl(config, loadRelayDevice());
  const openWebUrl = (url: string) => {
    setError("");
    void WebMode.open({ url }).catch(() => {
      // No native activity to carry it (a browser dev session, say): the
      // browser still opens it, which is the same page by another door.
      void Browser.open({ url }).catch(() => setError("打不开完整界面。"));
    });
  };

  return (
    <div
      className="connect"
      ref={scrollRef}
      onTouchStart={onPaneTouchStart}
      onTouchEnd={onPaneTouchEnd}
    >
      <div className="settings-bar">
        <header className="settings-head">
          {onClose ? (
            <button type="button" className="iconbtn" onClick={onClose} aria-label="返回">
              ←
            </button>
          ) : (
            <span className="bar-spacer" />
          )}
          <div className="settings-title">
            <h1>设置</h1>
          </div>
          {onClose ? (
            <button type="button" className="linkbtn" onClick={onClose}>
              完成
            </button>
          ) : (
            <span className="bar-spacer" />
          )}
        </header>

        <Segmented
          className="settings-tabs"
          ariaLabel="设置页面"
          value={pane}
          options={PANE_OPTIONS}
          onChange={choosePane}
        />
      </div>

      <div className="connect-body" data-dir={paneDir} key={pane}>
        {/* The computer this phone is pointed at and what the link is doing:
            the one fact every control below is judged against, so it leads. */}
        {pane === "connect" ? (
          <ConnectionHero name={heroName} detail={heroDetail} link={link} busy={busy} />
        ) : null}

        {/* How this phone reaches the computer: which network is live, and
            whether the proxy detours a VPN for LAN targets. The states the
            old VPN note repeated in three places are drawn here once. */}
        {pane === "connect" ? (
          <>
            <p className="group-label">网络</p>
            <section className="group">
              <div className="setting">
                <span className="setting-main">
                  <span className="setting-title">当前连接</span>
                  <span className="setting-sub">
                    {config?.mode === "relay"
                      ? "云端 · Reasonix 账号中继"
                      : config?.origin
                        ? `局域网 · ${config.origin}`
                        : "未连接"}
                  </span>
                </span>
                <span className="setting-value">
                  {config?.vpn ? "VPN 下" : config?.lan ? "Wi‑Fi/以太网" : "移动网络"}
                </span>
              </div>
              <div className="setting">
                <span className="setting-main">
                  <span className="setting-title">代理策略</span>
                  <Segmented
                    ariaLabel="代理策略"
                    value={netPolicy}
                    options={NET_POLICY_CHOICES}
                    onChange={pickNetPolicy}
                  />
                </span>
              </div>
            </section>
          </>
        ) : null}

        {pane === "connect" && webUrl ? (
          <>
            <p className="group-label">完整界面</p>
            <section className="group">
              <button
                type="button"
                className="setting action"
                onClick={() => openWebUrl(webUrl)}
                disabled={busy !== ""}
              >
                <span className="setting-main">
                  <span className="setting-title">在应用内打开</span>
                  <span className="setting-sub">电脑上那套 Studio 页面，整页运行在这里</span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
              <button
                type="button"
                className="setting action"
                onClick={() => {
                  setError("");
                  void Browser.open({ url: webUrl }).catch(() => setError("打不开浏览器。"));
                }}
                disabled={busy !== ""}
              >
                <span className="setting-main">
                  <span className="setting-title">在浏览器打开</span>
                  <span className="setting-sub">同一个页面，交给系统浏览器</span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </section>
          </>
        ) : null}

        {/* Places this phone has already connected to. The current one is
            marked; the rest are one tap away, with a way to forget a computer
            that moved or a device that left the account. */}
        {pane === "connect" && saved.length > 0 ? (
          <>
            <p className="group-label">已连接的电脑</p>
            <section
              className="group"
              ref={savedDrag.listRef}
              data-dragging={savedDrag.state ? "true" : undefined}
            >
              {groups.map((group, index) => {
                const door = groupDoor(group);
                const label = groupLabel(group, door);
                const here = groupHere(group);
                const shift = dragShift(savedDrag.state, index);
                // One computer can hold several doors — a LAN origin and a
                // cloud id, or two addresses of the same machine. The row taps
                // the best one; the doors under it are what a person can
                // forget one at a time.
                const many = group.rows.length > 1;
                return (
                  // The drag key sits on the wrapper, not the row inside it: a
                  // computer with doors is taller than its top row, and the
                  // drop indicator places itself from these boxes. Keying the
                  // inner row would leave the doors out of the height, so the
                  // indicator would land short and the ghost would trail.
                  <div
                    key={group.key}
                    className={`saved-group${savedDrag.state?.key === group.key ? " dragging" : ""}`}
                    data-drag-key={group.key}
                    data-drop={dropEdge(savedDrag.state, index, groups.length)}
                    style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
                    {...savedDrag.row(group.key)}
                  >
                    <div className="setting saved-row">
                      <button
                        type="button"
                        className="saved-main"
                        disabled={busy !== ""}
                        aria-current={here ? "true" : undefined}
                        onClick={() => void switchTo(door)}
                      >
                        <span className="setting-main">
                          <span className="setting-title">
                            {label}
                            {here ? <span className="saved-current">当前</span> : null}
                          </span>
                          <span className="setting-sub">{groupDetail(group, door)}</span>
                        </span>
                        <span className="chev" aria-hidden="true">
                          ›
                        </span>
                      </button>
                      {/* A single-door computer keeps its × on the row: there is
                          nothing to choose between, and a disclosure triangle
                          that opens one item is a step for no information. */}
                      {many ? null : (
                        <button
                          type="button"
                          className="saved-forget"
                          aria-label={`移除 ${label}`}
                          onClick={() => {
                            const wasHere = groupHere(group);
                            forgetDoor(door);
                            if (wasHere) void disconnect();
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {many
                      ? group.rows.map((row) => {
                          const rowHere = current(row);
                          return (
                            <div className="setting saved-row door" key={connectionKey(row.kind, row.target)}>
                              <span className="setting-main">
                                <span className="setting-title">
                                  {doorLabel(row)}
                                  {rowHere ? <span className="saved-current">当前</span> : null}
                                </span>
                                <span className="setting-sub">{doorDetail(row)}</span>
                              </span>
                              <button
                                type="button"
                                className="saved-forget"
                                aria-label={`移除 ${doorDetail(row)}`}
                                onClick={() => {
                                  forgetDoor(row);
                                  if (rowHere) void disconnect();
                                }}
                              >
                                ×
                              </button>
                            </div>
                          );
                        })
                      : null}
                  </div>
                );
              })}
            </section>
            {config?.origin || config?.mode === "relay" ? (
              <button type="button" className="setting action danger" onClick={() => void disconnect()} disabled={busy !== ""}>
                断开连接
              </button>
            ) : null}
          </>
        ) : null}

        {pane === "connect" ? (
          <>
            <p className="group-label">连接新电脑</p>
            <section className="group">
              <button type="button" className="setting" onClick={() => void scan()} disabled={busy !== ""}>
            <span className="setting-main">
              <span className="setting-title">
                {busy === "正在打开相机" ? "正在打开相机…" : "扫码连接"}
              </span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </button>
          <button type="button" className="setting" onClick={() => void pasteLink()} disabled={busy !== ""}>
            <span className="setting-main">
              <span className="setting-title">粘贴链接</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </button>
        </section>

        <details className="group manual-group">
          <summary className="setting manual-summary">
            <span className="setting-main">
              <span className="setting-title">手动填写地址</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </summary>
          <label className="setting">
            <span className="setting-title">服务器地址</span>
            <input
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="http://192.168.5.2:8791"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="setting">
            <span className="setting-title">配对码</span>
            <input
              value={pairCode}
              onChange={(event) => setPairCode(event.target.value)}
              placeholder="扫码后自动填写"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="setting action"
            onClick={() => void connect(origin, pairCode)}
            disabled={busy !== "" || !origin.trim()}
          >
            {busy === "正在连接" ? "正在连接…" : "连接"}
          </button>
        </details>

        {busy && busy !== "正在连接" && busy !== "正在打开相机" ? (
          <p className="group-note">{busy}…</p>
        ) : null}

        {error ? (
          <div className="notice error">
            {error}
            {retrust ? (
              <button
                type="button"
                className="notice-action"
                onClick={() => {
                  forgetDevice(retrust);
                  setRetrust(null);
                  void connectCloud(retrust);
                }}
              >
                这台电脑重装过，重新确认它的身份
              </button>
            ) : null}
          </div>
        ) : null}

          </>
        ) : null}

        {pane === "prefs" ? (
          <>
        <p className="group-label">通用</p>
        <section className="group">
          <div className="setting">
            <span className="setting-title">主题</span>
            <Segmented
              ariaLabel="主题"
              value={theme}
              options={THEME_CHOICES}
              onChange={pickTheme}
            />
          </div>
          <div className="setting">
            <span className="setting-title">会话</span>
            <Segmented
              ariaLabel="会话详略"
              value={fold}
              options={FOLD_CHOICES}
              onChange={pickFold}
            />
          </div>
          <div className="setting">
            <span className="setting-title">会话字号</span>
            <Segmented
              ariaLabel="会话字号"
              value={chatFont}
              options={CHAT_FONT_CHOICES}
              onChange={pickChatFont}
            />
          </div>
          <div className="setting">
            <span className="setting-title">Enter 键</span>
            <Segmented
              ariaLabel="Enter 键行为"
              value={enterPref}
              options={ENTER_CHOICES}
              onChange={pickEnterPref}
            />
          </div>
          <div className="setting">
            <span className="setting-title">震动</span>
            <Switch checked={haptics} onChange={pickHaptics} ariaLabel="震动" />
          </div>
          {/* The two surfaces under the master switch. Off is off: a row here
              cannot re-enable feedback the master just silenced, so the rows
              are disabled rather than merely inert — a switch that moves and
              changes nothing is the worse lie. */}
          <div className="setting sub">
            <span className="setting-main">
              <span className="setting-title">拖拽与长按</span>
              <span className="setting-sub">长按呼出操作、拖动排序时震动</span>
            </span>
            <Switch
              checked={hapticDrag}
              onChange={pickHapticDrag}
              ariaLabel="拖拽与长按震动"
              disabled={!haptics}
            />
          </div>
          <div className="setting sub">
            <span className="setting-main">
              <span className="setting-title">回答开始与结束</span>
              <span className="setting-sub">只在开头和结尾震一次，生成过程中不震</span>
            </span>
            <Switch
              checked={hapticStream}
              onChange={pickHapticStream}
              ariaLabel="回答开始与结束震动"
              disabled={!haptics}
            />
          </div>
          {Capacitor.isNativePlatform() && onCloudWatchChange ? (
            <div className="setting">
              <span className="setting-main">
                <span className="setting-title">云端后台提醒</span>
                <span className="setting-sub">App 在后台时留意云端会话；滑掉任务后失效</span>
              </span>
              <Switch
                checked={cloudWatch ?? false}
                onChange={onCloudWatchChange}
                ariaLabel="云端后台提醒"
              />
            </div>
          ) : null}
        </section>

        {Capacitor.isNativePlatform() && onNotifyPrefChange ? (
          <>
            <p className="group-label">通知</p>
            <section className="group">
              {/*
                The people who most need these switches are the ones a
                permanent icon annoys, so the ongoing row leads and says what
                "off" actually does: the service keeps running, the icon goes.
                Calling it "关闭" would promise a teardown that cannot happen.
              */}
              <div className="setting">
                <span className="setting-main">
                  <span className="setting-title">常驻通知</span>
                  <span className="setting-sub">
                    关闭后不出现在状态栏，后台提醒仍然工作
                  </span>
                </span>
                <Switch
                  checked={notifyPrefs?.ongoing ?? false}
                  onChange={(on) => onNotifyPrefChange("ongoing", on)}
                  ariaLabel="常驻通知"
                />
              </div>
              <div className="setting sub">
                <span className="setting-main">
                  <span className="setting-title">需要你处理</span>
                  <span className="setting-sub">有提问、批准或恢复选择等你回答时提醒</span>
                </span>
                <Switch
                  checked={notifyPrefs?.ask ?? true}
                  onChange={(on) => onNotifyPrefChange("ask", on)}
                  ariaLabel="需要你处理的通知"
                />
              </div>
              <div className="setting sub">
                <span className="setting-main">
                  <span className="setting-title">弹窗提醒</span>
                  <span className="setting-sub">
                    关闭后只进通知栏，不弹出横幅
                  </span>
                </span>
                <Switch
                  checked={notifyPrefs?.headsUp ?? true}
                  onChange={(on) => onNotifyPrefChange("headsUp", on)}
                  ariaLabel="弹窗提醒"
                  disabled={!(notifyPrefs?.ask ?? true)}
                />
              </div>
              <div className="setting sub">
                <span className="setting-main">
                  <span className="setting-title">会话完成</span>
                  <span className="setting-sub">一轮跑完时提醒</span>
                </span>
                <Switch
                  checked={notifyPrefs?.done ?? true}
                  onChange={(on) => onNotifyPrefChange("done", on)}
                  ariaLabel="会话完成的通知"
                />
              </div>
              {onNotificationOptionsChange ? (
                <div className="setting sub">
                  <span className="setting-main">
                    <span className="setting-title">在通知里显示选项</span>
                    <span className="setting-sub">
                      关闭时只显示「去回答」，点击直接进入该会话
                    </span>
                  </span>
                  <Switch
                    checked={notificationOptions ?? false}
                    onChange={onNotificationOptionsChange}
                    ariaLabel="通知里显示选项"
                    disabled={!(notifyPrefs?.ask ?? true)}
                  />
                </div>
              ) : null}
            </section>
          </>
        ) : null}

        {background ? (
          <>
            <p className="group-label">后台运行</p>
            <section className="group">
              <button type="button" className="setting" onClick={openNotificationSettings}>
                <span className="setting-main">
                  <span className="setting-title">通知</span>
                </span>
                <span className="setting-value">
                  {background.notifications ? "已开启" : "已关闭"}
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
              <button type="button" className="setting" onClick={openBatterySettings}>
                <span className="setting-main">
                  <span className="setting-title">电池优化</span>
                </span>
                <span className="setting-value">
                  {background.exempt ? "已允许" : "受限"}
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </section>
          </>
        ) : null}

        <p className="group-label">关于</p>
        <section className="group">
          <div className="setting">
            <span className="setting-title">版本</span>
            <span className="setting-value">{__APP_VERSION__}</span>
          </div>
          {Capacitor.isNativePlatform() ? (
            <UpdateRow status={updater.status} onAction={updater.act} />
          ) : null}
          {buildDiagnostics ? (
            <button
              type="button"
              className="setting"
              onClick={() => {
                void (async () => {
                  try {
                    await Clipboard.write({ string: await buildDiagnostics() });
                    setDiagStatus("已复制");
                  } catch {
                    setDiagStatus("复制失败");
                  }
                })();
              }}
            >
              <span className="setting-main">
                <span className="setting-title">复制诊断信息</span>
                <span className="setting-sub">版本、网络、WebView 和最近错误；不含聊天内容</span>
              </span>
              <span className="setting-value">{diagStatus || "复制"}</span>
            </button>
          ) : null}
        </section>
          </>
        ) : null}

        {pane === "account" ? (
          <>
        <p className="group-label">Reasonix 账号</p>
        <section className="group">
          {account.signedIn ? (
            <>
              <div className="setting">
                <span className="setting-main">
                  <span className="setting-title">
                    {account.user?.label ?? account.user?.handle ?? "已登录"}
                  </span>
                </span>
              </div>
              <button type="button" className="setting action danger" onClick={() => void signOut()}>
                退出登录
              </button>
            </>
          ) : (
            <button type="button" className="setting action" onClick={() => void signIn()} disabled={busy !== ""}>
              {busy === "正在获取登录码" ? "正在获取登录码…" : "登录 Reasonix 账号"}
            </button>
          )}
        </section>
        {busy === "正在获取登录码" ? (
          <p className="group-note account-busy">正在向登录服务申请登录码，最多等 25 秒…</p>
        ) : null}
        {signInError ? (
          <div className="notice error account-notice" role="alert">
            {signInError}
          </div>
        ) : null}

        {grant ? (
          <section className="group grant">
            {approved ? <p className="group-note">已批准，正在完成登录…</p> : null}
            <div className="code">{grant.userCode}</div>
            {approved ? null : (
              <>
                <label className="setting">
                  <span className="setting-title">邮箱</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="username"
                    disabled={accountBusy !== ""}
                  />
                </label>
                <label className="setting">
                  <span className="setting-title">密码</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="账号密码"
                    autoComplete="current-password"
                    disabled={accountBusy !== ""}
                  />
                </label>
                <button
                  type="button"
                  className="setting action"
                  onClick={() => void nativeSignIn()}
                  disabled={accountBusy !== "" || !email.trim() || password === ""}
                >
                  {accountBusy || "登录并批准"}
                </button>
              </>
            )}
            <button
              type="button"
              className="setting action"
              onClick={() => openLoginPage(grant.verificationUriComplete)}
              disabled={accountBusy !== "" || approved}
            >
              在网页中登录（注册 / 找回密码）
            </button>
            <button
              type="button"
              className="setting action"
              onClick={cancelGrant}
              disabled={accountBusy !== ""}
            >
              取消
            </button>
          </section>
        ) : null}

        {account.signedIn && devices.length > 0 ? (
          <>
            <p className="group-label">云端电脑</p>
            <section className="group">
              {devices.map((device) => {
                const ready =
                  !Array.isArray(device.capabilities) || device.capabilities.includes("desktop");
                return (
                  <button
                    key={device.id}
                    type="button"
                    className="setting"
                    disabled={busy !== "" || !ready}
                    onClick={() => void connectCloud(device.id)}
                  >
                    <span className="setting-main">
                      <span className="setting-title">
                        {device.name ?? device.id}
                        {device.platform ? ` · ${device.platform}` : ""}
                      </span>
                    </span>
                    <span className="setting-value">{ready ? "可远程" : "未开启"}</span>
                    <span className="chev" aria-hidden="true">
                      ›
                    </span>
                  </button>
                );
              })}
            </section>
          </>
        ) : null}
          </>
        ) : null}
      </div>

      {trustAsk ? (
        <div className="sheet-backdrop" role="presentation" onClick={() => settleTrust(false)}>
          <div
            className="sheet trust-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trust-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-head">
              <h2 id="trust-title">确认这台电脑</h2>
            </div>
            <p className="trust-device">
              {devices.find((device) => device.id === trustAsk.id)?.name ?? trustAsk.id}
            </p>
            <p className="group-note">
              第一次用云端连接这台电脑。记住它的身份后，钥匙一旦变化，手机会拒绝连接，而不是悄悄改用新身份。
            </p>
            <div className="trust-fingerprint" aria-label="电脑身份指纹">
              {trustAsk.fingerprint}
            </div>
            <ul className="sheet-actions">
              <li>
                <button type="button" onClick={() => settleTrust(true)}>
                  信任并连接
                </button>
              </li>
              <li>
                <button type="button" className="trust-cancel" onClick={() => settleTrust(false)}>
                  取消
                </button>
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
