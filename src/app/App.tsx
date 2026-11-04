import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { onNetworkChange, readNetworkStatus } from "../native/networkWatch";
import type { NetworkStatus } from "../net/network";
import { Connection } from "../net/connection";
import type { ConnectionSnapshot } from "../net/connection";
import { Fleet, originKey, syncFleetPeer } from "../net/fleet";
import type { FleetSnapshot, FleetPendingItem, FleetRunningItem } from "../net/fleet";
import { bootstrap } from "../net/token";
import { configureProxy, firstAnswering, readProxyConfig } from "../net/server";
import { submit } from "../net/submit";
import type { SubmitResult } from "../net/submit";
import {
  applyNotificationPrefs,
  setNotificationOptions,
  startTurnNotification,
  startCloudWatch,
  stopCloudWatch,
} from "../native/turn";
import type { ProxyConfig } from "../net/server";
import { clearRelayRouting, connectRelay } from "../net/relay";
import { loadRelayDevice, saveRelayDevice, loadStandDown } from "../net/relayStore";
import { loadConnections } from "../net/savedConnections";
import { Home } from "./Home";
import type { HomeTab } from "./swipe";
import { parseChatLink } from "./chatLink";
import { SessionList, runtimeOpenMessage } from "./SessionList";
import { ConnectScreen } from "./ConnectScreen";
import { closeTopSheet } from "./backStack";
import { useLink } from "./useLink";
import { useNeedsYou } from "./useNeedsYou";
import { useTree } from "./useTree";
import { loadCloudWatch, saveCloudWatch } from "./cloudWatchPref";
import {
  loadNotificationOptions,
  saveNotificationOptions,
} from "./notificationOptionsPref";
import {
  loadNotificationPrefs,
  saveNotificationPref,
} from "./notifyPref";
import type { NotificationPrefs } from "./notifyPref";
import { buildDiagnostics } from "./diagnostics";
import { openRuntime as openRuntimeOn } from "../net/workspaces";
import "../ui/tokens.css";
import "../ui/shell.css";
import "../ui/chat.css";
import "../ui/connect.css";

// The chat carries Markdown and syntax highlighting; a phone that only reads
// the list should not pay for them at launch.
const ChatScreen = lazy(() =>
  import("../chat/ChatScreen").then((module) => ({ default: module.ChatScreen })),
);

const connection = new Connection();
const fleetWatcher = new Fleet();

type Boot = "loading" | "connect" | "ready";

/**
 * How often a live link is checked while the app is on screen.
 *
 * Slow on purpose: this is a safety net for a route that died while nobody
 * was looking, not a heartbeat. Every check is one `/runtimes` read against
 * the kernel, and the retry path already runs when the person acts.
 */
const LINK_WATCH_MS = 30_000;

/** Every LAN address worth trying, the proxy's own first, duplicates removed. */
function lanDoors(config: ProxyConfig | null): string[] {
  const saved = loadConnections()
    .filter((row) => row.kind === "lan")
    .map((row) => row.target);
  return [...new Set([config?.origin ?? "", ...(config?.candidates ?? []), ...saved].filter(Boolean))];
}

/** Why a dispatched turn did not start, as a sentence. */
function dispatchFailure(result: SubmitResult): string {
  if (result.unconfirmed) {
    return "请求已经发出但没有回执，去列表确认任务是否已经开始。";
  }
  switch (result.code) {
    case "client.offline":
      return "连不上电脑，任务没有派出去。";
    case "client.timeout":
      return "电脑没有及时回应，任务可能已经开始，先去列表确认。";
    default:
      return `没派出去：${result.code ?? "unknown"}`;
  }
}

/**
 * The app shell. It holds one connection and one piece of navigation state,
 * because a phone shows one screen at a time and a second source of that truth
 * would only disagree with the first.
 *
 * Navigation is two levels deep before a conversation: projects, then that
 * project's conversations, then the chat. A flat list of open panes was the
 * earlier shape and it answered the wrong question — it showed what the
 * desktop had running, drew one project three times when three panes were
 * open on it, and could not reach a conversation that had no pane.
 *
 * On Android the bundle is served by the loopback proxy, and the first
 * question is whether that proxy has an upstream yet. A browser dev session
 * has no proxy and no connect screen: it starts ready, exactly as before.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(connection.current);
  const [fleet, setFleet] = useState<FleetSnapshot>(fleetWatcher.current);
  const [openRuntime, setOpenRuntime] = useState<string | null>(null);
  /** The project whose conversation list is showing, by root. */
  const [project, setProject] = useState<string | null>(null);
  /**
   * Which home view was showing. It lives here so leaving a project returns to
   * the list the person opened it from, not to the default view.
   */
  const [homeTab, setHomeTab] = useState<HomeTab>("recent");
  /**
   * The project the open chat belongs to. Held separately from the runtime
   * snapshot because the pane was opened a moment ago and the list may not
   * carry it yet; deriving it from there made the chat's "new session" button
   * vanish exactly when a fresh conversation was open.
   */
  const [chatProject, setChatProject] = useState<string | null>(null);
  /** The open conversation's title, as the list that opened it knew it. */
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [boot, setBoot] = useState<Boot>(() => (Capacitor.isNativePlatform() ? "loading" : "ready"));
  const tree = useTree();
  const pending = useNeedsYou(snapshot.runtimes, tree.projects, tree.revision);
  const link = useLink(connection);
  /** Cloud background reminders; default off and only meaningful on a cloud link. */
  const [cloudWatch, setCloudWatchState] = useState(() => loadCloudWatch());
  const pickCloudWatch = useCallback((on: boolean) => {
    saveCloudWatch(on);
    setCloudWatchState(on);
  }, []);
  /** Inline ask options; off means one 去回答 action that opens the conversation. */
  const [notificationOptions, setNotificationOptionsState] = useState(
    () => loadNotificationOptions(),
  );
  const pickNotificationOptions = useCallback((on: boolean) => {
    saveNotificationOptions(on);
    setNotificationOptionsState(on);
  }, []);
  useEffect(() => {
    setNotificationOptions(notificationOptions);
  }, [notificationOptions]);
  /**
   * Which notification surfaces post, and whether ask interrupts.
   *
   * Kept in React state so the settings rows redraw, and pushed to the service
   * on every change: the service is what posts while the WebView is gone, so a
   * choice that only lived here would stop applying the moment the screen
   * closed.
   */
  const [notifyPrefs, setNotifyPrefsState] = useState<NotificationPrefs>(() =>
    loadNotificationPrefs(),
  );
  const pickNotifyPref = useCallback(
    (name: keyof NotificationPrefs, on: boolean) => {
      saveNotificationPref(name, on);
      setNotifyPrefsState((current) => ({ ...current, [name]: on }));
      applyNotificationPrefs({ [name]: on });
    },
    [],
  );
  // The stored choices live in this WebView's localStorage; the service reads
  // its own copy, which a fresh install has not filled in yet. Pushing them
  // once on mount is what keeps the two in step for a phone that updates from
  // a build without these switches.
  useEffect(() => {
    applyNotificationPrefs(loadNotificationPrefs());
  }, []);
  const [chatFocusAsk, setChatFocusAsk] = useState(false);
  const buildDiagnosticsText = useCallback(
    () => buildDiagnostics({ link: link.state, snapshot, cloudWatch }),
    [link.state, snapshot, cloudWatch],
  );

  // Coming back from a failed or retried link is the moment the lists are
  // most likely to be stale: the old read may have gone through a dead door.
  const wasConnected = useRef(false);
  useEffect(() => {
    const now = link.state.phase === "connected";
    if (now && !wasConnected.current) tree.reload();
    wasConnected.current = now;
  }, [link.state.phase, tree.reload]);

  useEffect(() => connection.subscribe(setSnapshot), [connection]);
  useEffect(() => fleetWatcher.subscribe(setFleet), []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    // Once the six-second gate has handed over to the app, the slow chain
    // behind it stops steering screens: a "connect" verdict arriving after
    // the person is already looking at the home screen would yank them out
    // of it. The chain keeps running — configureProxy still re-arms the
    // proxy — but only the gate and a pre-gate verdict pick the screen.
    let gated = false;
    // The boot gate must answer quickly: a relay handshake or a dead LAN
    // probe can each spend tens of seconds, and that is a white screen the
    // person cannot act on. Six seconds covers a healthy path; anything
    // slower hands over to the app, where the link machine keeps recovering
    // in the open and the connection bar shows the progress.
    const gate = window.setTimeout(() => {
      gated = true;
      if (!cancelled) setBoot("ready");
    }, 6_000);
    void (async () => {
      const config = await readProxyConfig();
      if (cancelled) return;
      // A proxy that cannot be read is an old shell or a dev WebView: let the
      // normal browser path try rather than trapping the app on "loading".
      if (config === null) {
        setBoot("ready");
        return;
      }
      if (config.mode === "relay" && config.relayDevice) {
        saveRelayDevice(config.relayDevice);
        try {
          await connectRelay(config.relayDevice);
          if (!cancelled) setBoot("ready");
        } catch {
          // The relay did not open. A remembered LAN address may still answer;
          // trying it is cheaper than sending the person back to a QR code.
          // Prefer an address that answers now, not only the one the proxy
          // happened to hold before the relay took over.
          const alive = await firstAnswering(lanDoors(config));
          if (alive !== null) {
            try {
              clearRelayRouting();
              await configureProxy(alive);
              if (!cancelled) setBoot("ready");
              return;
            } catch {
              // fall through to the connect screen
            }
          }
          if (!cancelled && !gated) setBoot("connect");
        }
        return;
      }
      clearRelayRouting();
      if (config.origin) {
        setBoot("ready");
        return;
      }
      // No upstream, but a remembered one is still a way back to the app: the
      // recovery pass right after boot is what actually connects it.
      const recorded = loadConnections();
      const remembered =
        recorded.some((row) => row.kind === "lan") ||
        (config.account.signedIn &&
          (Boolean(loadRelayDevice()) || recorded.some((row) => row.kind === "cloud")));
      setBoot(remembered ? "ready" : "connect");
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(gate);
    };
  }, []);

  useEffect(() => {
    if (boot !== "ready") return;
    let cancelled = false;
    void bootstrap().then(() => {
      // The first attempt verifies whatever the proxy was told at boot and
      // prefers a LAN door if one answers. A phone the person disconnected on
      // purpose stays offline: the stand-down mark survives the restart, and
      // only a tap in the settings or the switch sheet reconnects.
      if (!cancelled && !loadStandDown()) link.kick();
    });
    return () => {
      cancelled = true;
    };
  }, [boot, link.kick]);

  /**
   * Re-read the watch list and watch it.
   *
   * The fleet exists only where the proxy does, and reads only while the app
   * is on screen. The tick itself is harmless when no peer is watchable, so
   * running the cadence from the first read that finds one is enough — the
   * same call serves the boot and every connection made later in settings.
   */
  const syncFleet = useCallback(() => {
    void fleetWatcher.refresh().then(() => {
      if (fleetWatcher.current.peers.some((peer) => peer.state !== "unwatchable")) {
        fleetWatcher.start();
      }
    });
  }, []);

  useEffect(() => {
    if (boot !== "ready") return;
    syncFleet();
    return () => fleetWatcher.stop();
  }, [boot, syncFleet]);

  // A switch is the moment "the computer I am on" changes; the fleet block
  // hides that computer's rows so a conversation never appears twice. The
  // computer being used is also added to the watch list: once the person
  // switches away, its blocked conversations are exactly what the fleet shows.
  useEffect(() => {
    if (link.state.phase !== "connected" || !link.state.target) return;
    const kind = link.state.mode ?? "lan";
    fleetWatcher.setActiveTarget(kind, link.state.target);
    void syncFleetPeer(kind, link.state.target, link.state.name ?? link.state.target)
      .then(syncFleet)
      .catch(() => {
        // The watch list is a mirror; a failed write must not break the link.
      });
    // A cloud link may be the same computer as a remembered LAN door; if the
    // phone is already on that Wi-Fi, prefer the direct one now.
    if (kind === "cloud") link.preferLan();
  }, [
    link.state.phase,
    link.state.target,
    link.state.mode,
    link.state.name,
    link.preferLan,
    syncFleet,
  ]);

  const hasWatchedTurns =
    pending.items.length > 0 ||
    pending.running.length > 0 ||
    fleet.pending.length > 0 ||
    fleet.running.length > 0;

  // The native watcher discovers every open pane itself; a running or
  // blocked pane on this computer *or another watched one* is the trigger
  // that makes sure it exists. It polls the LAN proxy directly; a cloud link
  // has its own foreground watcher, armed by the switch below.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (link.state.mode !== "lan" || !hasWatchedTurns) return;
    startTurnNotification();
  }, [link.state.mode, hasWatchedTurns]);

  /**
   * Keep the shared service in the mode the link and the switch ask for.
   *
   * A process-local ref is not evidence that the service matches it: an
   * activity can be recreated while a cloud watcher keeps running, and the LAN
   * link would then leave it in cloud mode. The native stop is a no-op unless
   * the service is actually a cloud watcher, so reconciling on every mode
   * change cannot kill a LAN watch.
   */
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (cloudWatch && link.state.mode === "cloud") startCloudWatch();
    else stopCloudWatch();
  }, [cloudWatch, link.state.mode]);

  const [actionError, setActionError] = useState("");
  /** A peer notification waits for the boot link to settle before switching. */
  const [pendingLink, setPendingLink] = useState<string | null>(null);

  const reloadTree = tree.reload;
  const refresh = useCallback(() => {
    void link.kick();
    reloadTree();
  }, [link.kick, reloadTree]);

  /** A pane the kernel just answered is not in the snapshot yet. */
  const openedRuntime = useCallback(async (id: string, root: string, title: string) => {
    setChatProject(root);
    setChatTitle(title);
    await connection.refresh();
    setOpenRuntime(id);
  }, []);

  const openProject = useCallback(
    (root: string) => {
      setActionError("");
      setProject(root);
      // A project's list is a snapshot of its conversations; coming back to it
      // after a turn is the moment it is most likely to be stale.
      reloadTree();
    },
    [reloadTree],
  );

  /**
   * Start a conversation in the project the chat belongs to. The phone may not
   * pick a folder, but a project it is already inside is a known root, so this
   * is the same `POST /runtimes` the project screen uses.
   */
  const newSessionInProject = useCallback(
    async (root: string) => {
      setActionError("");
      const result = await openRuntimeOn(root);
      if (!result.ok) {
        setActionError(runtimeOpenMessage(result.code));
        return;
      }
      setProject(root);
      await openedRuntime(result.runtime.id, root, "新会话");
      reloadTree();
    },
    [openedRuntime, reloadTree],
  );

  /**
   * Send a task and leave it running. The pane is created and submitted
   * without opening the chat; the native turn service watches it so the
   * answer or completion still reaches the phone.
   */
  const dispatchTask = useCallback(
    async (root: string, prompt: string) => {
      if (link.state.phase !== "connected") {
        return { ok: false, message: "先连接电脑再派任务。" };
      }
      const opened = await openRuntimeOn(root);
      if (!opened.ok) return { ok: false, message: runtimeOpenMessage(opened.code) };
      const sent = await submit(opened.runtime.base, prompt);
      if (!sent.ok) return { ok: false, message: dispatchFailure(sent) };
      const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
      // The native watcher reads the LAN proxy; a relayed kernel has no path
      // there. Do not start a foreground service that cannot answer.
      if (link.state.mode !== "cloud") {
        startTurnNotification({
          title: firstLine.slice(0, 60) || "派发的任务",
          base: opened.runtime.base,
          root,
          runtimeId: opened.runtime.id,
        });
      }
      setActionError("");
      // The pane was created a moment ago and is not in the snapshot yet, so
      // the home screen's "正在运行" block would not know about it until the
      // next timer tick. Refreshing here is what makes a dispatched task
      // visible the moment it starts. Not awaited: the dispatch already
      // succeeded, and the row arrives through the subscription.
      void connection.refresh();
      reloadTree();
      return { ok: true };
    },
    [link.state.mode, link.state.phase, reloadTree],
  );

  /** Leaving a conversation returns to its project, not to the project list. */
  const closeRuntime = useCallback(() => {
    setOpenRuntime(null);
    setChatFocusAsk(false);
    reloadTree();
  }, [reloadTree]);

  /**
   * A decision notification carries the conversation it was raised in.
   *
   * It is navigation, not a new pane: the runtime already exists on the
   * desktop, and the chat reads its history on mount. The refresh is for the
   * snapshot's runtimes, which may predate the notification by a few minutes.
   */
  const openChatLink = useCallback(async (raw: string) => {
    const parsed = parseChatLink(raw);
    if (!parsed) return;
    const settling =
      boot === "loading" ||
      link.state.phase === "connecting" ||
      link.state.phase === "reconnecting" ||
      link.state.phase === "offline" ||
      (boot === "ready" && link.state.phase === "idle");
    if (parsed.peer && settling) {
      setPendingLink(raw);
      return;
    }
    setShowConnect(false);
    if (parsed.peer) {
      // A notification for another watched computer must switch before it
      // opens a runtime id that only means something on that kernel. The
      // target must be one this phone already knows; a link cannot repoint
      // the proxy at an arbitrary origin.
      const key = originKey("lan", parsed.peer);
      const saved = loadConnections();
      const known =
        saved.some((row) => row.kind === "lan" && originKey("lan", row.target) === key) ||
        fleetWatcher.current.peers.some(
          (peer) => peer.kind === "lan" && originKey("lan", peer.target) === key,
        );
      if (!known) {
        setActionError("这条通知指向的电脑不在连接列表里。");
        return;
      }
      const here =
        Boolean(link.state.target) && originKey("lan", link.state.target ?? "") === key;
      if (!here) {
        const entry = saved.find(
          (row) => row.kind === "lan" && originKey("lan", row.target) === key,
        );
        const result = await link.switchTo({
          kind: "lan",
          target: parsed.peer,
          name: entry?.name ?? parsed.peerName ?? parsed.peer,
        });
        if (!result.ok) {
          setActionError("没能切到那台电脑，稍后再试。");
          return;
        }
      }
    }
    if (parsed.root) {
      setProject(parsed.root);
      setChatProject(parsed.root);
    }
    setChatTitle(parsed.title ?? null);
    setChatFocusAsk(parsed.focusAsk === true);
    setOpenRuntime(parsed.runtimeId);
    void connection.refresh();
  }, [boot, link]);

  useEffect(() => {
    if (pendingLink === null) return;
    const settling =
      boot === "loading" ||
      link.state.phase === "connecting" ||
      link.state.phase === "reconnecting" ||
      link.state.phase === "offline" ||
      (boot === "ready" && link.state.phase === "idle");
    if (settling) return;
    setPendingLink(null);
    void openChatLink(pendingLink);
  }, [pendingLink, boot, link.state.phase, openChatLink]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void NativeApp.addListener("appUrlOpen", (event) => {
      if (event.url) openChatLink(event.url);
    }).then((handle) => {
      if (cancelled) {
        void handle.remove();
        return;
      }
      remove = () => {
        void handle.remove();
      };
    });
    if (typeof NativeApp.getLaunchUrl === "function") {
      void NativeApp.getLaunchUrl()
        .then((result) => {
          if (!cancelled && result?.url) openChatLink(result.url);
        })
        .catch(() => {
          // A link that cannot be read is not a reason to fail the launch.
        });
    }
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [openChatLink]);

  const onConnected = useCallback(() => {
    setShowConnect(false);
    setBoot("ready");
    void link.noteConnected();
    // A connection made in the settings screen may have added a row to the
    // watch list; the fleet re-reads it so its indexes and names are current.
    syncFleet();
    void readProxyConfig().then((next) => {
      if (next === null) return;
      if (next.relayDevice) saveRelayDevice(next.relayDevice);
    });
  }, [link.noteConnected, syncFleet]);

  /**
   * A conversation on another computer: switch the connection to it, and only
   * then open the pane.
   *
   * The switch is the same verified door the switch sheet uses, so a refused
   * switch (an expired pairing, a computer that is gone) leaves the app where
   * it was instead of half-moving. After the switch the pane list is already
   * fresh: a pane the desktop still has is opened by navigation alone, and
   * one that closed since the sweep is opened by binding its transcript —
   * never a minted pane for a conversation the person only wanted to read.
   */
  const openFleetItem = useCallback(
    async (item: FleetPendingItem | FleetRunningItem) => {
      setActionError("");
      const peer = fleetWatcher.current.peers.find((candidate) => candidate.index === item.peer);
      if (!peer || !peer.target) {
        setActionError("找不到这台电脑的连接记录，请在设置里重新连接。");
        return;
      }
      const result = await link.switchTo({
        kind: peer.kind,
        target: peer.target,
        name: peer.name,
      });
      if (!result.ok) {
        setActionError("没能连上这台电脑，请稍后再试。");
        return;
      }
      // The verified connection may have added a row to the proxy's watch
      // list; re-reading it keeps the indexes and names here the same ones
      // the sweeps are addressing.
      void fleetWatcher.refresh();
      const stillThere = connection.current.runtimes.some((runtime) => runtime.id === item.runtimeId);
      setChatProject(item.projectRoot);
      setChatTitle(item.title);
      if (stillThere) {
        setOpenRuntime(item.runtimeId);
        return;
      }
      if (item.sessionPath) {
        const opened = await openRuntimeOn(item.projectRoot, item.sessionPath);
        if (opened.ok) {
          setOpenRuntime(opened.runtime.id);
          return;
        }
      }
      setActionError("这个会话已经不在那台电脑上了。");
    },
    [link],
  );

  // Coming back from the background must re-probe: the kernel may have been
  // restarted or the phone may have changed networks while the screen was off.
  useEffect(() => {
    if (boot !== "ready") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      link.kick();
      // Coming back on the home Wi-Fi is the usual moment a cloud link can
      // become a direct LAN one.
      link.preferLan();
      // The desktop may have moved a prompt or finished a turn while the
      // screen was off; the home block and the tree are both snapshots.
      pending.refresh();
      reloadTree();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [boot, link.kick, link.preferLan, pending.refresh, reloadTree]);

  // A live link is checked on a slow timer, and only a route that has really
  // stopped answering (two lost reads in a row) is reopened. Without this,
  // making a screen mounting harmless would also make a dead route invisible:
  // the chip would keep saying 已连接 while the list could not refresh.
  useEffect(() => {
    if (boot !== "ready") return;
    if (link.state.phase !== "connected") return;
    const timer = window.setInterval(() => {
      link.watch();
      // A phone that came home while the screen stayed on should not wait for
      // a foreground event to take the faster door.
      link.preferLan();
    }, LINK_WATCH_MS);
    return () => window.clearInterval(timer);
  }, [boot, link.state.phase, link.watch, link.preferLan]);

  // A phone frozen in the background comes back holding a stream whose peer
  // went away while nothing was watching. No error fires and the status still
  // reads "connected", so the pane would never update again; a resume is the
  // only notice it gets. `reassess` verifies the route and rebuilds a stream
  // that still answers, and no-ops when the link is not connected or another
  // check is already running.
  //
  // This is not `noteNetwork`: a foreground is not a network change, and the
  // route comparison there returns early unless the network actually moved.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void NativeApp.addListener("appStateChange", (state) => {
      if (state.isActive) link.reassess();
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
  }, [link.reassess]);

  // The platform's own answer about this phone's network. A default network
  // returning starts a fresh walk; a change while the boolean stays true
  // (Wi-Fi A→B, cellular→Wi-Fi) is passed through as a change too, so the link
  // machine verifies the route instead of waiting for the watch timer.
  //
  // NetworkWatch is native because Capacitor's Network plugin reports a
  // validated internet connection: a LAN-only Wi-Fi would read as offline, and
  // a Wi-Fi handover with no dropout would read as no change.
  //
  // Android can deliver the transition while the app is paused, so the current
  // status is also asked for at boot and whenever the app returns to the
  // foreground. A resume is a change only when the network itself moved; a
  // plain foreground check stays the watch/kick path.
  useEffect(() => {
    if (boot !== "ready" || !Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    let last: NetworkStatus | null = null;
    const moved = (next: NetworkStatus) =>
      last !== null &&
      (last.connected !== next.connected ||
        last.connectionType !== next.connectionType ||
        last.networkKey !== next.networkKey);
    const apply = (status: NetworkStatus, changed: boolean) => {
      if (cancelled) return;
      last = status;
      link.noteNetwork(status, changed);
    };
    const ask = () => {
      void readNetworkStatus().then((status) => {
        if (status !== null) apply(status, moved(status));
      });
    };
    ask();
    void onNetworkChange((status) => apply(status, true)).then((handle) => {
      if (cancelled) {
        void handle?.remove();
        return;
      }
      remove = () => {
        void handle?.remove();
      };
    });
    document.addEventListener("visibilitychange", onVisible);
    function onVisible() {
      if (document.visibilityState === "visible") ask();
    }
    return () => {
      cancelled = true;
      remove?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [boot, link.noteNetwork]);

  // Android's back gesture leaves a single-page app rather than going back a
  // screen, so the screen it should have gone back to is stated here. On the
  // phone Capacitor's backButton is the source of truth; the history entry is
  // only for a browser/PWA.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void NativeApp.addListener("backButton", () => {
      // A sheet is the innermost thing on screen, whatever screen it covers.
      if (closeTopSheet()) return;
      if (showConnect) {
        setShowConnect(false);
        return;
      }
      // A conversation is inside a project, so leaving one lands on that
      // project's list rather than at the top. The project list is the root.
      if (openRuntime) {
        setOpenRuntime(null);
        reloadTree();
        return;
      }
      if (project) {
        setProject(null);
        return;
      }
      void NativeApp.exitApp();
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
  }, [openRuntime, project, showConnect, reloadTree]);

  useEffect(() => {
    if (!openRuntime || Capacitor.isNativePlatform()) return;
    const onPop = () => setOpenRuntime(null);
    window.history.pushState({ screen: "chat" }, "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openRuntime]);

  const shownProject = project === null
    ? null
    : tree.projects.find((candidate) => candidate.root === project) ?? null;
  /**
   * Which project the open chat belongs to. The pane may not be in the
   * snapshot yet, so the root recorded when it was opened wins; the snapshot is
   * the fallback for a pane opened by the desktop and reached from here.
   */
  const chatRoot = chatProject
    ?? snapshot.runtimes.find((candidate) => candidate.id === openRuntime)?.root
    ?? "";

  let screen: ReactNode;
  if (boot === "loading") {
    screen = (
      <div className="centered">
        <div>
          <strong>正在准备</strong>
          检查这台手机上的连接。
        </div>
      </div>
    );
  } else if (boot === "connect") {
    screen = (
      <ConnectScreen
        onConnected={onConnected}
        onFailed={link.noteFailed}
        onDisconnected={link.noteDisconnected}
        link={link.state}
        cloudWatch={cloudWatch}
        onCloudWatchChange={pickCloudWatch}
        notificationOptions={notificationOptions}
        onNotificationOptionsChange={pickNotificationOptions}
        notifyPrefs={notifyPrefs}
        onNotifyPrefChange={pickNotifyPref}
        buildDiagnostics={buildDiagnosticsText}
      />
    );
  } else if (showConnect) {
    // The kernel keeps the approval posture on the hub and persists it, so any
    // pane speaks for it; the first one is simply the cheapest to address.
    screen = (
      <ConnectScreen
        onConnected={onConnected}
        onFailed={link.noteFailed}
        onDisconnected={link.noteDisconnected}
        onClose={() => {
          setShowConnect(false);
          // A removed computer shifted the watch rows; re-read them before
          // the home screen draws names from the old indexes.
          syncFleet();
        }}
        link={link.state}
        cloudWatch={cloudWatch}
        onCloudWatchChange={pickCloudWatch}
        notificationOptions={notificationOptions}
        onNotificationOptionsChange={pickNotificationOptions}
        notifyPrefs={notifyPrefs}
        onNotifyPrefChange={pickNotifyPref}
        buildDiagnostics={buildDiagnosticsText}
      />
    );
  } else if (openRuntime) {
    screen = (
      <ChatScreen
        key={openRuntime}
        connection={connection}
        snapshot={snapshot}
        runtimeId={openRuntime}
        {...(chatTitle ? { title: chatTitle } : {})}
        onBack={closeRuntime}
        mode={link.state.mode}
        focusAsk={chatFocusAsk}
        onFocusConsumed={() => setChatFocusAsk(false)}
        {...(chatRoot ? { onNewSession: () => void newSessionInProject(chatRoot) } : {})}
      />
    );
  } else if (project !== null) {
    screen = shownProject ? (
      <SessionList
        snapshot={snapshot}
        tree={tree}
        project={shownProject}
        onBack={() => setProject(null)}
        onOpen={(id, title) => void openedRuntime(id, shownProject.root, title)}
        onRefresh={refresh}
      />
    ) : (
      <div className="shell">
        <div className="bar">
          <button type="button" className="iconbtn" onClick={() => setProject(null)} aria-label="返回项目列表">
            ←
          </button>
          <h1>项目</h1>
        </div>
        <div className="centered">
          <div>
            <strong>找不到这个项目</strong>
            它可能已经从桌面端的列表里移除了。
          </div>
        </div>
      </div>
    );
  } else {
    screen = (
      <Home
        snapshot={snapshot}
        tree={tree}
        pending={pending}
        tab={homeTab}
        onTabChange={setHomeTab}
        link={link.state}
        onSwitchConnection={(entry) => void link.switchTo(entry)}
        onRetryLink={link.retry}
        onOpenProject={openProject}
        onOpenSession={(id, root, title) => void openedRuntime(id, root, title)}
        // The pane is already running, so opening it is navigation only: the
        // same call the list uses, minus the POST that opened it.
        onOpenRuntime={(id, root, title) => void openedRuntime(id, root, title)}
        onNewSession={(root) => void newSessionInProject(root)}
        onDispatch={dispatchTask}
        onRefresh={refresh}
        onSettings={() => setShowConnect(true)}
        fleet={fleet}
        onOpenFleet={(item) => void openFleetItem(item)}
      />
    );
  }

  return (
    <>
      <Suspense
        fallback={
          <div className="centered">
            <div>正在打开会话…</div>
          </div>
        }
      >
        {screen}
      </Suspense>
      {actionError ? (
        <div className="sendfail" role="alert">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")}>
            知道了
          </button>
        </div>
      ) : null}
    </>
  );
}
