import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  checkForUpdate,
  installUpdate,
  launchInstaller,
  onUpdateProgress,
} from "../native/update";
import { isNativeUpdate, updateFailure } from "./update";
import type { UpdateStatus } from "./update";

type Available = Extract<UpdateStatus, { kind: "available" }>;

/**
 * The update row's state machine. The phone shell owns the download; this hook
 * only decides what the row says and which native call the next tap makes.
 */
export function useUpdater(enabled: boolean): { status: UpdateStatus; act: () => void } {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const available = useRef<Available | null>(null);

  const check = useCallback(async (force: boolean) => {
    if (!isNativeUpdate()) return;
    setStatus({ kind: "checking" });
    try {
      const result = await checkForUpdate(force);
      if (result.update) {
        const next: Available = {
          kind: "available",
          version: result.version,
          versionCode: result.versionCode,
          url: result.url,
          mirrors: result.mirrors,
          notes: result.notes,
        };
        available.current = next;
        setStatus(next);
        return;
      }
      available.current = null;
      setStatus({ kind: "latest", version: result.installedVersion || result.version });
    } catch (error) {
      setStatus({ kind: "error", message: updateFailure(error), retry: "check" });
    }
  }, []);

  const download = useCallback(async () => {
    const next = available.current;
    if (!next) {
      void check(true);
      return;
    }
    setStatus({ kind: "downloading", version: next.version, transferred: 0, total: 0 });
    try {
      const result = await installUpdate(next.url, next.mirrors, next.versionCode);
      setStatus(
        result.state === "permission"
          ? { kind: "permission", version: next.version }
          : { kind: "downloaded", version: next.version },
      );
    } catch (error) {
      setStatus({ kind: "error", message: updateFailure(error), retry: "install" });
    }
  }, [check]);

  const resume = useCallback(async () => {
    const version = available.current?.version ?? "";
    try {
      const result = await launchInstaller();
      setStatus(
        result.state === "permission"
          ? { kind: "permission", version }
          : { kind: "downloaded", version },
      );
    } catch (error) {
      setStatus({ kind: "error", message: updateFailure(error), retry: "install" });
    }
  }, []);

  const act = useCallback(() => {
    switch (status.kind) {
      case "available":
        void download();
        return;
      case "permission":
      case "downloaded":
        void resume();
        return;
      case "checking":
      case "downloading":
        return;
      case "error":
        if (status.retry === "install") void download();
        else void check(true);
        return;
      case "idle":
        void check(false);
        return;
      case "latest":
        void check(true);
        return;
    }
  }, [status, check, download, resume]);

  // Opening the pane checks once; the native side throttles the network call
  // for six hours, so re-opening the sheet does not ask GitHub again.
  useEffect(() => {
    if (!enabled || status.kind !== "idle") return;
    void check(false);
  }, [enabled, status.kind, check]);

  useEffect(() => {
    if (!isNativeUpdate()) return;
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void onUpdateProgress((progress) => {
      setStatus((current) =>
        current.kind === "downloading"
          ? { ...current, transferred: progress.transferred, total: progress.total }
          : current,
      );
    })
      .then((registered) => {
        if (cancelled) void registered.remove();
        else handle = registered;
      })
      .catch(() => {
        // Progress is decoration; the resolved install still changes the row.
      });
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, []);

  return { status, act };
}
