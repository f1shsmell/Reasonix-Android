import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

/**
 * The native updater. Checking reads the release manifest; installing
 * downloads the APK and hands it to the system installer, which is the only
 * component allowed to replace the app.
 */
export interface UpdateCheck {
  update: boolean;
  tag: string;
  version: string;
  versionCode: number;
  apk: string;
  url: string;
  mirrors: string[];
  notes: string;
  installedVersion: string;
  installedCode: number;
}

export interface UpdateProgress {
  transferred: number;
  total: number;
}

export interface UpdateInstallResult {
  state: "downloaded" | "permission";
}

interface UpdaterPlugin {
  check(options: { force?: boolean }): Promise<UpdateCheck>;
  install(options: {
    url: string;
    mirrors: string;
    versionCode: number;
  }): Promise<UpdateInstallResult>;
  launchInstaller(): Promise<UpdateInstallResult>;
  addListener(
    eventName: "progress",
    listener: (progress: UpdateProgress) => void,
  ): Promise<PluginListenerHandle>;
}

const Updater = registerPlugin<UpdaterPlugin>("Updater");

export function checkForUpdate(force: boolean): Promise<UpdateCheck> {
  return Updater.check({ force });
}

/** The mirror list crosses the bridge as JSON: it is one field, not an ABI. */
export function installUpdate(
  url: string,
  mirrors: string[],
  versionCode: number,
): Promise<UpdateInstallResult> {
  return Updater.install({ url, mirrors: JSON.stringify(mirrors), versionCode });
}

export function launchInstaller(): Promise<UpdateInstallResult> {
  return Updater.launchInstaller();
}

export function onUpdateProgress(
  listener: (progress: UpdateProgress) => void,
): Promise<PluginListenerHandle> {
  return Updater.addListener("progress", listener);
}
