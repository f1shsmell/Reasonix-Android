import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { Connection } from "../net/connection";
import type { ConnectionSnapshot } from "../net/connection";
import { bootstrap } from "../net/token";
import { configureProxy, markRelay, readProxyConfig, refreshProxy } from "../net/server";
import type { ProxyConfig } from "../net/server";
import { clearRelayRouting, connectRelay, ensureRelay } from "../net/relay";
import { withTimeout } from "../net/http";
import { loadRelayDevice, saveRelayDevice } from "../net/relayStore";
import { ChatScreen } from "../chat/ChatScreen";
import { SessionList } from "./SessionList";
import { ConnectScreen } from "./ConnectScreen";
import { ProjectSheet } from "./ProjectSheet";
import "../ui/tokens.css";
import "../ui/shell.css";
import "../ui/chat.css";
import "../ui/connect.css";
import "../ui/sheet.css";

const connection = new Connection();

type Boot = "loading" | "connect" | "ready";

/**
 * The app shell. It holds one connection and one piece of navigation state,
 * because a phone shows one screen at a time and a second source of that truth
 * would only disagree with the first.
 *
 * On Android the bundle is served by the loopback proxy, and the first
 * question is whether that proxy has an upstream yet. A browser dev session
 * has no proxy and no connect screen: it starts ready, exactly as before.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(connection.current);
  const [openRuntime, setOpenRuntime] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [boot, setBoot] = useState<Boot>(() => (Capacitor.isNativePlatform() ? "loading" : "ready"));
  const [sheet, setSheet] = useState<{ base: string; root: string } | null>(null);
  const configRef = useRef<ProxyConfig | null>(null);
  const recovering = useRef(false);

  /**
   * A phone changes networks while the app is open, and a Studio can restart
   * under the same LAN address. One recovery pass: let the proxy re-probe its
   * LAN candidates, read `/runtimes`, then try the other transport if that
   * failed. It is idempotent and guarded so visibility and network events
   * cannot overlap into two switches.
   */
  const recover = useCallback(async () => {
    if (recovering.current) return;
    recovering.current = true;
    const reachKind = () => connection.current.reach.kind;
    try {
      const fresh = await refreshProxy();
      if (fresh !== null) configRef.current = fresh;
      const known = fresh ?? configRef.current;

      // A relay link that ended during the night must be reopened before the
      // probe, or the probe would fail through a dead socket and trigger a
      // needless switch to LAN.
      if (known?.mode === "relay" && known.relayDevice) {
        try {
          await withTimeout(ensureRelay(known.relayDevice), 45_000, "relay did not open in time");
        } catch {
          // the probe below still runs; LAN is the other door
        }
      }

      await connection.refresh();
      if (reachKind() === "ok") return;

      // relay -> LAN, the faster path when this phone is back on the Wi-Fi
      if (known?.mode === "relay" && known.origin) {
        try {
          const lan = await configureProxy(known.origin);
          clearRelayRouting();
          configRef.current = lan;
          await connection.refresh();
          if (reachKind() === "ok") return;

          // The saved LAN origin did not answer either. Restore the relay
          // rather than leaving the person with two closed doors.
          const device = known.relayDevice || loadRelayDevice();
          if (device) {
            try {
              await withTimeout(ensureRelay(device), 45_000, "relay did not open in time");
              configRef.current = await markRelay(device);
              saveRelayDevice(device);
              await connection.refresh();
            } catch {
              // leave the unreachable state visible
            }
          }
        } catch {
          // configureProxy refused; the current relay may still work
        }
      }

      // LAN -> relay, for leaving the house
      if (known?.mode !== "relay" && known?.account.signedIn) {
        const device = known.relayDevice || loadRelayDevice();
        if (device) {
          try {
            await withTimeout(ensureRelay(device), 45_000, "relay did not open in time");
            configRef.current = await markRelay(device);
            saveRelayDevice(device);
            await connection.refresh();
          } catch {
            // leave the LAN state visible
          }
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
          if (!cancelled) setBoot("ready");
        } catch {
          // The relay did not open. A remembered LAN origin may still answer;
          // trying it is cheaper than sending the person back to a QR code.
          if (config.origin) {
            try {
              clearRelayRouting();
              const lan = await configureProxy(config.origin);
              configRef.current = lan;
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
      setBoot(config.origin ? "ready" : "connect");
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

  const refresh = useCallback(() => void connection.refresh(), []);
  const openSheet = useCallback(
    (runtimeId?: string) => {
      const id = runtimeId ?? openRuntime ?? snapshot.runtimes[0]?.id;
      const runtime = snapshot.runtimes.find((candidate) => candidate.id === id);
      if (!runtime) return;
      setSheet({ base: runtime.base, root: runtime.root });
    },
    [openRuntime, snapshot.runtimes],
  );

  const openedRuntime = useCallback(
    async (id: string) => {
      setSheet(null);
      // The new pane is not in the snapshot yet; refresh before opening it so
      // ChatScreen does not flash "session not found".
      await connection.refresh();
      setOpenRuntime(id);
    },
    [],
  );

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
      // A sheet is the topmost surface even though it is rendered beside the
      // screen, not inside it. Without this, back exits the app while a sheet
      // is visibly open.
      if (sheet) {
        setSheet(null);
        return;
      }
      if (showConnect) {
        setShowConnect(false);
        return;
      }
      if (openRuntime) {
        setOpenRuntime(null);
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
  }, [openRuntime, sheet, showConnect]);

  useEffect(() => {
    if (!openRuntime || Capacitor.isNativePlatform()) return;
    const onPop = () => setOpenRuntime(null);
    window.history.pushState({ screen: "chat" }, "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openRuntime]);

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
    screen = <ConnectScreen onConnected={onConnected} onClose={() => setShowConnect(false)} />;
  } else if (openRuntime) {
    screen = (
      <ChatScreen
        key={openRuntime}
        connection={connection}
        snapshot={snapshot}
        runtimeId={openRuntime}
        onBack={() => setOpenRuntime(null)}
        onNewSession={() => openSheet(openRuntime)}
      />
    );
  } else {
    screen = (
      <SessionList
        snapshot={snapshot}
        onOpen={setOpenRuntime}
        onRefresh={refresh}
        onSettings={() => setShowConnect(true)}
        {...(snapshot.runtimes.length > 0 ? { onNew: () => openSheet() } : {})}
      />
    );
  }

  return (
    <>
      {screen}
      {sheet ? (
        <ProjectSheet
          base={sheet.base}
          root={sheet.root}
          onClose={() => setSheet(null)}
          onOpened={(id) => void openedRuntime(id)}
        />
      ) : null}
    </>
  );
}
