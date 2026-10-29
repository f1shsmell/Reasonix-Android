import { useCallback, useEffect, useState } from "react";
import { Connection } from "../net/connection";
import type { ConnectionSnapshot } from "../net/connection";
import { bootstrap } from "../net/token";
import { ChatScreen } from "../chat/ChatScreen";
import { SessionList } from "./SessionList";
import "../ui/tokens.css";
import "../ui/shell.css";
import "../ui/chat.css";

const connection = new Connection();

/**
 * The app shell. It holds one connection and one piece of navigation state,
 * because a phone shows one screen at a time and a second source of that truth
 * would only disagree with the first.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(connection.current);
  const [openRuntime, setOpenRuntime] = useState<string | null>(null);

  useEffect(() => connection.subscribe(setSnapshot), [connection]);

  useEffect(() => {
    let cancelled = false;
    void bootstrap().then(() => {
      if (!cancelled) void connection.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull to refresh is the gesture people try first on a list that looks stale.
  const refresh = useCallback(() => void connection.refresh(), []);

  // Coming back from the background must re-probe: the kernel may have been
  // restarted or the phone may have changed networks while the screen was off.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // Android's back gesture leaves a single-page app rather than going back a
  // screen, so the screen it should have gone back to is stated here.
  useEffect(() => {
    if (!openRuntime) return;
    const onPop = () => setOpenRuntime(null);
    window.history.pushState({ screen: "chat" }, "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openRuntime]);

  if (openRuntime) {
    return (
      <ChatScreen
        connection={connection}
        snapshot={snapshot}
        runtimeId={openRuntime}
        onBack={() => setOpenRuntime(null)}
      />
    );
  }

  return (
    <SessionList
      snapshot={snapshot}
      onOpen={setOpenRuntime}
      onRefresh={refresh}
    />
  );
}
