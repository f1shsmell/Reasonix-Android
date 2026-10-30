import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { Connection } from "../net/connection";
import type { ConnectionSnapshot } from "../net/connection";
import { bootstrap } from "../net/token";
import { configureProxy, markRelay, originAnswers, readProxyConfig, refreshProxy } from "../net/server";
import type { ProxyConfig } from "../net/server";
import { clearRelayRouting, connectRelay, ensureRelay } from "../net/relay";
import { withTimeout } from "../net/http";
import { loadRelayDevice, saveRelayDevice } from "../net/relayStore";
import { loadConnections, rememberConnection } from "../net/savedConnections";
import { ChatScreen } from "../chat/ChatScreen";
import { Home } from "./Home";
import type { HomeTab } from "./swipe";
import { SessionList, runtimeOpenMessage } from "./SessionList";
import { ConnectScreen } from "./ConnectScreen";
import { useNeedsYou } from "./useNeedsYou";
import { useTree } from "./useTree";
import { openRuntime as openRuntimeOn } from "../net/workspaces";
import "../ui/tokens.css";
import "../ui/shell.css";
import "../ui/chat.css";
import "../ui/connect.css";

const connection = new Connection();

type Boot = "loading" | "connect" | "ready";

/** Every LAN address worth trying, the proxy's own first, duplicates removed. */
function lanDoors(config: ProxyConfig | null): string[] {
  const saved = loadConnections()
    .filter((row) => row.kind === "lan")
    .map((row) => row.target);
  return [...new Set([config?.origin ?? "", ...(config?.candidates ?? []), ...saved].filter(Boolean))];
}

/** The first remembered LAN address that answers at all, in preference order. */
async function firstAnswering(doors: string[]): Promise<string | null> {
  const answers = await Promise.all(
    doors.map(async (origin) => ({ origin, ok: await originAnswers(origin) })),
  );
  return answers.find((entry) => entry.ok)?.origin ?? null;
}

/** The cloud device a recovery should try: the active one, the hint, then the record. */
function relayDoor(config: ProxyConfig | null): string {
  return (
    config?.relayDevice ||
    loadRelayDevice() ||
    loadConnections().find((row) => row.kind === "cloud")?.target ||
    ""
  );
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
  const pending = useNeedsYou(tree.projects, tree.revision);
  const configRef = useRef<ProxyConfig | null>(null);
  const recovering = useRef(false);

  /**
   * A phone changes networks while the app is open, and a Studio can restart
   * under the same LAN address. One recovery pass, preferring the LAN: if any
   * remembered local address answers, the relay is not needed even when it
   * still works. The account is the fallback for when none does, and an open
   * relay is reopened before its probe so a dead socket is not mistaken for a
   * missing computer. It is idempotent and guarded so visibility and network
   * events cannot overlap into two switches.
   */
  const recover = useCallback(async () => {
    if (recovering.current) return;
    recovering.current = true;
    const reachKind = () => connection.current.reach.kind;
    try {
      const fresh = await refreshProxy();
      if (fresh !== null) configRef.current = fresh;
      const known = fresh ?? configRef.current;
      const signedIn = known?.account.signedIn === true;
      const device = signedIn ? relayDoor(known) : "";
      const doors = lanDoors(known);

      // Already on LAN: re-probing the candidates is the whole job while it
      // answers. A failed read falls through to the other doors.
      if (known?.mode !== "relay" && known?.origin) {
        await connection.refresh();
        if (reachKind() === "ok") {
          rememberConnection("lan", known.origin);
          return;
        }
      }

      // Prefer the LAN even while a relay works: back on the computer's Wi-Fi
      // it is the faster path and the one that costs no account traffic. A
      // door that answers is only trusted after the kernel itself does.
      const alive = doors.length > 0 ? await firstAnswering(doors) : null;
      if (alive !== null && !(known?.mode !== "relay" && alive === known?.origin)) {
        try {
          const next = await configureProxy(alive);
          clearRelayRouting();
          configRef.current = next;
          await connection.refresh();
          if (reachKind() === "ok") {
            rememberConnection("lan", alive);
            // Keep the cloud id as the hint for the next time this phone
            // leaves the Wi-Fi.
            if (device) saveRelayDevice(device);
            return;
          }
        } catch {
          // The door answered but the kernel did not. The account is next.
        }
      }

      // The account is the other door, and the only one that leaves the LAN.
      if (device) {
        try {
          await withTimeout(ensureRelay(device), 45_000, "relay did not open in time");
          configRef.current = await markRelay(device);
          saveRelayDevice(device);
          rememberConnection("cloud", device);
          await connection.refresh();
        } catch {
          // leave the unreachable state visible
        }
      }
    } finally {
      recovering.current = false;
    }
  }, []);

  useEffect(() => connection.subscribe(setSnapshot), [connection]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    void (async () => {
      const config = await readProxyConfig();
      if (cancelled) return;
      // A proxy that cannot be read is an old shell or a dev WebView: let the
      // normal browser path try rather than trapping the app on "loading".
      if (config === null) {
        setBoot("ready");
        return;
      }
      configRef.current = config;
      if (config.mode === "relay" && config.relayDevice) {
        saveRelayDevice(config.relayDevice);
        try {
          await connectRelay(config.relayDevice);
          rememberConnection("cloud", config.relayDevice);
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
              const lan = await configureProxy(alive);
              configRef.current = lan;
              rememberConnection("lan", alive);
              if (!cancelled) setBoot("ready");
              return;
            } catch {
              // fall through to the connect screen
            }
          }
          if (!cancelled) setBoot("connect");
        }
        return;
      }
      clearRelayRouting();
      if (config.origin) {
        rememberConnection("lan", config.origin);
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
    };
  }, []);

  useEffect(() => {
    if (boot !== "ready") return;
    let cancelled = false;
    void bootstrap().then(() => {
      if (!cancelled) void recover();
    });
    return () => {
      cancelled = true;
    };
  }, [boot, recover]);

  const [actionError, setActionError] = useState("");

  const reloadTree = tree.reload;
  const refresh = useCallback(() => {
    void connection.refresh();
    reloadTree();
  }, [reloadTree]);

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

  /** Leaving a conversation returns to its project, not to the project list. */
  const closeRuntime = useCallback(() => {
    setOpenRuntime(null);
    reloadTree();
  }, [reloadTree]);

  const onConnected = useCallback(() => {
    setShowConnect(false);
    setBoot("ready");
    void readProxyConfig().then((next) => {
      if (next === null) return;
      configRef.current = next;
      if (next.relayDevice) saveRelayDevice(next.relayDevice);
    });
  }, []);

  // Coming back from the background must re-probe: the kernel may have been
  // restarted or the phone may have changed networks while the screen was off.
  useEffect(() => {
    if (boot !== "ready") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void recover();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [boot, recover]);

  // The proxy retries the remembered origins on a network change; recovery
  // then checks the other transport if nothing answered.
  useEffect(() => {
    if (boot !== "ready" || !Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void Network.addListener("networkStatusChange", (status) => {
      if (!status.connected) return;
      void recover();
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
  }, [boot, recover]);

  // Once the list is known to be unreachable, keep trying on a slow timer;
  // a phone can sit on a dying Wi-Fi for minutes with no visibility or network
  // event to wake it. The guard in `recover` keeps these from overlapping.
  useEffect(() => {
    if (boot !== "ready" || snapshot.reach.kind !== "unreachable") return;
    const timer = window.setInterval(() => void recover(), 15_000);
    return () => window.clearInterval(timer);
  }, [boot, snapshot.reach.kind, recover]);

  // Android's back gesture leaves a single-page app rather than going back a
  // screen, so the screen it should have gone back to is stated here. On the
  // phone Capacitor's backButton is the source of truth; the history entry is
  // only for a browser/PWA.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void NativeApp.addListener("backButton", () => {
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
    screen = <ConnectScreen onConnected={onConnected} />;
  } else if (showConnect) {
    // The kernel keeps the approval posture on the hub and persists it, so any
    // pane speaks for it; the first one is simply the cheapest to address.
    screen = (
      <ConnectScreen
        onConnected={onConnected}
        onClose={() => setShowConnect(false)}
        {...(snapshot.runtimes[0]?.base ? { runtimeBase: snapshot.runtimes[0].base } : {})}
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
        onOpenProject={openProject}
        onOpenSession={(id, root, title) => void openedRuntime(id, root, title)}
        // The pane is already running, so opening it is navigation only: the
        // same call the list uses, minus the POST that opened it.
        onOpenRuntime={(id, root, title) => void openedRuntime(id, root, title)}
        onNewSession={(root) => void newSessionInProject(root)}
        onRefresh={refresh}
        onSettings={() => setShowConnect(true)}
      />
    );
  }

  return (
    <>
      {screen}
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
