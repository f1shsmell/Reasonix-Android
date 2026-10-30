import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { Connection } from "../net/connection";
import type { ConnectionSnapshot } from "../net/connection";
import { bootstrap } from "../net/token";
import { configureProxy, firstAnswering, readProxyConfig } from "../net/server";
import type { ProxyConfig } from "../net/server";
import { clearRelayRouting, connectRelay } from "../net/relay";
import { loadRelayDevice, saveRelayDevice } from "../net/relayStore";
import { loadConnections } from "../net/savedConnections";
import { ChatScreen } from "../chat/ChatScreen";
import { Home } from "./Home";
import type { HomeTab } from "./swipe";
import { parseChatLink } from "./chatLink";
import { SessionList, runtimeOpenMessage } from "./SessionList";
import { ConnectScreen } from "./ConnectScreen";
import { closeTopSheet } from "./backStack";
import { useLink } from "./useLink";
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
  const link = useLink(connection);

  // Coming back from a failed or retried link is the moment the lists are
  // most likely to be stale: the old read may have gone through a dead door.
  const wasConnected = useRef(false);
  useEffect(() => {
    const now = link.state.phase === "connected";
    if (now && !wasConnected.current) tree.reload();
    wasConnected.current = now;
  }, [link.state.phase, tree.reload]);

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
          if (!cancelled) setBoot("connect");
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
    };
  }, []);

  useEffect(() => {
    if (boot !== "ready") return;
    let cancelled = false;
    void bootstrap().then(() => {
      // The first attempt verifies whatever the proxy was told at boot and
      // prefers a LAN door if one answers.
      if (!cancelled) link.kick();
    });
    return () => {
      cancelled = true;
    };
  }, [boot, link.kick]);

  const [actionError, setActionError] = useState("");

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

  /** Leaving a conversation returns to its project, not to the project list. */
  const closeRuntime = useCallback(() => {
    setOpenRuntime(null);
    reloadTree();
  }, [reloadTree]);

  /**
   * A decision notification carries the conversation it was raised in.
   *
   * It is navigation, not a new pane: the runtime already exists on the
   * desktop, and the chat reads its history on mount. The refresh is for the
   * snapshot's runtimes, which may predate the notification by a few minutes.
   */
  const openChatLink = useCallback((raw: string) => {
    const link = parseChatLink(raw);
    if (!link) return;
    setShowConnect(false);
    if (link.root) {
      setProject(link.root);
      setChatProject(link.root);
    }
    setChatTitle(link.title ?? null);
    setOpenRuntime(link.runtimeId);
    void connection.refresh();
  }, []);

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
    void readProxyConfig().then((next) => {
      if (next === null) return;
      if (next.relayDevice) saveRelayDevice(next.relayDevice);
    });
  }, [link.noteConnected]);

  // Coming back from the background must re-probe: the kernel may have been
  // restarted or the phone may have changed networks while the screen was off.
  useEffect(() => {
    if (boot !== "ready") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      link.kick();
      // The desktop may have moved a prompt or finished a turn while the
      // screen was off; the home block and the tree are both snapshots.
      pending.refresh();
      reloadTree();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [boot, link.kick, pending.refresh, reloadTree]);

  // The proxy retries the remembered origins on a network change; the link
  // machine then checks the other transport if nothing answered.
  useEffect(() => {
    if (boot !== "ready" || !Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let remove: (() => void) | undefined;
    void Network.addListener("networkStatusChange", (status) => {
      if (!status.connected) return;
      link.kick();
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
  }, [boot, link.kick]);

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
      <ConnectScreen onConnected={onConnected} onFailed={link.noteFailed} link={link.state} />
    );
  } else if (showConnect) {
    // The kernel keeps the approval posture on the hub and persists it, so any
    // pane speaks for it; the first one is simply the cheapest to address.
    screen = (
      <ConnectScreen
        onConnected={onConnected}
        onFailed={link.noteFailed}
        onClose={() => setShowConnect(false)}
        link={link.state}
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
