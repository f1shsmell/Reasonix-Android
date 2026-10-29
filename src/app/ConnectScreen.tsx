/**
 * The first screen on a phone: point the app at a kernel.
 *
 * A QR code carries either a LAN origin with a one-time pairing code, or the
 * Internet link. The pairing is spent by the loopback proxy, so the app never
 * puts the code in a URL and the device cookie lands on the app's own origin.
 * Account sign-in uses the device flow: a short code approved in the phone's
 * browser, with the session token kept by the proxy.
 */

import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import { Network } from "@capacitor/network";
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
  readProxyConfig,
  refreshProxy,
  signOutAccount,
  startAccount,
} from "../net/server";
import type { DeviceGrant, ProxyAccount, ProxyConfig, RemoteDevice, ServerLink } from "../net/server";
import { clearRelayRouting, connectRelay, RelayError } from "../net/relay";
import { clearRelayDevice } from "../net/relayStore";
import { NativeLogin } from "../native/login";
import { NativePair } from "../native/pair";

export interface ConnectScreenProps {
  onConnected: () => void;
  /** Present when this screen was opened over an existing connection. */
  onClose?: () => void;
}

export function ConnectScreen({ onConnected, onClose }: ConnectScreenProps) {
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [origin, setOrigin] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [account, setAccount] = useState<ProxyAccount>({ signedIn: false });
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [grant, setGrant] = useState<DeviceGrant | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void readProxyConfig().then((next) => {
      if (cancelled || next === null) return;
      setConfig(next);
      setAccount(next.account);
      setOrigin(next.origin);
    });
    return () => {
      cancelled = true;
    };
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
      const apply = (next: ProxyConfig) => {
        // Only after the new LAN upstream is saved: a failed attempt must
        // leave an existing relay connection alone.
        clearRelayRouting();
        setConfig(next);
        setAccount(next.account);
        setOrigin(next.origin);
        setPairCode("");
        onConnected();
      };
      try {
        if (viaWeb) {
          let paired = false;
          try {
            // The Studio page's own #pair bootstrap is the path a browser
            // uses; the hidden WebView runs it and leaves its cookie for the
            // proxy. The direct POST /pair below is only the fallback.
            const result = await NativePair.pair({
              url: `${base}/#pair=${encodeURIComponent(pairCodeValue)}`,
              origin: base,
            });
            paired = result.paired;
          } catch {
            paired = false;
          }
          if (!paired) {
            setError(
              "配对没有完成：配对码可能已过期，或已经被浏览器用过。请在电脑上点「换一个」后重新扫码。",
            );
            return;
          }
          apply(await configureProxy(base));
          return;
        }
        apply(await configureProxy(base, pairCodeValue || undefined));
      } catch (failure) {
        const failureCode = failure instanceof Error ? failure.message : "unknown";
        const where = base;
        if (failureCode === "device.pairing_invalid") {
          setError(
            `配对码已失效（地址 ${where}，App 用的码 ${pairCodeValue || "(空)"}）。` +
              "浏览器能连时，点「粘贴链接」用浏览器地址栏的完整链接；或者点「换一个」重新扫码。",
          );
          // Keep the code visible: it is the one value worth comparing with
          // the browser's address bar when the scanner misread the QR.
        } else if (failureCode === "device.pair_route_missing") {
          setError(`这个地址不是局域网配对端口（${where}）。请用二维码里的地址，不要手填 8791。`);
          setPairCode("");
        } else if (failureCode === "device.pair_unreachable" || failureCode === "proxy.upstream_unreachable") {
          setError("到不了这台电脑：确认手机和电脑在同一 Wi-Fi，并使用二维码里的地址。");
          setPairCode("");
        } else {
          setError(`没连上：${failureCode}`);
        }
      } finally {
        setBusy("");
      }
    },
    [onConnected],
  );

  const connectCloud = useCallback(
    async (deviceId: string) => {
      const target = devices.find((device) => device.id === deviceId);
      if (target && Array.isArray(target.capabilities) && !target.capabilities.includes("desktop")) {
        setError("这台电脑没有开启「互联网远程访问」。请在电脑 Studio 的「设备访问」里打开互联网连接后再试。");
        return;
      }
      setBusy("正在连接云端");
      setError("");
      let link: Awaited<ReturnType<typeof connectRelay>> | null = null;
      try {
        link = await connectRelay(deviceId);
        const next = await markRelay(deviceId);
        setConfig(next);
        setAccount(next.account);
        onConnected();
      } catch (failure) {
        // `connectRelay` only replaces the active link after its handshake
        // succeeds. If it threw, `link` is null and an existing relay must be
        // left alone; otherwise remove the link that did replace it.
        if (link !== null) clearRelayRouting();
        if (failure instanceof RelayError && failure.kind === "reauth") {
          setError("登录已过期，请重新登录 Reasonix 账号。");
        } else {
          setError(failure instanceof Error ? `云端连接没建立：${failure.message}` : "云端连接没建立");
        }
      } finally {
        setBusy("");
      }
    },
    [devices, onConnected],
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
    void Network.addListener("networkStatusChange", (status) => {
      if (!status.connected) return;
      // The phone may have moved networks; the proxy retries the remembered
      // origins and this screen picks up whichever one answered.
      void refreshProxy().then((next) => {
        if (next === null) return;
        setConfig(next);
        setAccount(next.account);
        setOrigin(next.origin);
      });
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
  }, []);

  const openLoginPage = useCallback((url: string) => {
    if (Capacitor.isNativePlatform()) {
      void NativeLogin.open({ url }).catch(() => Browser.open({ url }));
    } else {
      void Browser.open({ url });
    }
  }, []);

  const signIn = useCallback(async () => {
    setBusy("正在获取登录码");
    setError("");
    try {
      const next = await startAccount();
      setGrant(next);
      openLoginPage(next.verificationUriComplete);
    } catch (failure) {
      setError(failure instanceof Error ? `登录服务不可用：${failure.message}` : "登录服务不可用");
    } finally {
      setBusy("");
    }
  }, [openLoginPage]);

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
        setError("登录码已过期，请重新登录。");
        return;
      }
      try {
        const result = await pollAccount(grant.deviceCode);
        if (cancelled) return;
        if (result.status === "complete") {
          setGrant(null);
          setAccount({ signedIn: true, ...(result.user ? { user: result.user } : {}) });
          return;
        }
        if (result.status === "ended" || result.status === "error") {
          setGrant(null);
          setError(result.status === "ended" ? "登录已取消或过期。" : "登录失败，请重试。");
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

  const signOut = useCallback(async () => {
    try {
      setAccount(await signOutAccount());
      setDevices([]);
      clearRelayRouting();
      clearRelayDevice();
      await clearRelay();
    } catch (failure) {
      setError(failure instanceof Error ? `退出失败：${failure.message}` : "退出失败");
    }
  }, []);

  const known = config?.origin ?? "";

  return (
    <div className="connect">
      {onClose ? (
        <button type="button" className="iconbtn connect-back" onClick={onClose} aria-label="返回">
          ←
        </button>
      ) : null}
      <div className="connect-head">
        <h1>Reasonix</h1>
        <p>连接一台正在运行 Reasonix 的电脑</p>
      </div>

      <div className="connect-body">
        <button type="button" className="primary" onClick={() => void scan()} disabled={busy !== ""}>
          {busy === "正在打开相机" ? "正在打开相机…" : "扫码连接"}
        </button>
        <button type="button" onClick={() => void pasteLink()} disabled={busy !== ""}>
          粘贴链接
        </button>
        <div className="meta">
          浏览器扫码能连、App 不能时：复制浏览器地址栏的完整链接，点「粘贴链接」。
        </div>
        <div className="divider">或者手动填写</div>

        <label>
          服务器地址
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
        <label>
          配对码（可选）
          <input
            value={pairCode}
            onChange={(event) => setPairCode(event.target.value)}
            placeholder="扫码后自动填写"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="meta">配对码 5 分钟内有效，且只能用一次；建议直接扫码。</div>
        {busy ? <div className="meta">{busy}…</div> : null}
        <details className="meta">
          <summary>局域网还是连不上？</summary>
          <div>
            用电脑「设备访问」里的局域网二维码，地址通常是 http://电脑IP:随机端口，不要手填
            8791（那是 Studio 主服务端口）。手机浏览器也打不开二维码链接时，检查电脑防火墙是否放行该端口、手机和电脑是否在同一
            Wi-Fi、路由器是否开启了 AP 隔离或 VPN。
          </div>
        </details>
        <button
          type="button"
          onClick={() => void connect(origin, pairCode)}
          disabled={busy !== "" || !origin.trim()}
        >
          {busy === "正在连接" ? "正在连接…" : "连接"}
        </button>

        {known ? (
          <div className="meta">
            上次连接：{known}
            {config && config.candidates.length > 1 ? ` · 还有 ${config.candidates.length - 1} 个备用地址` : ""}
          </div>
        ) : null}

        {error ? <div className="notice error">{error}</div> : null}

        <div className="card account">
          <h2>Reasonix 账号</h2>
          {account.signedIn ? (
            <>
              <div className="meta">
                已登录{account.user?.label ?? account.user?.handle ? `：${account.user.label ?? account.user.handle}` : ""}
              </div>
              <div className="meta">云端连接使用同一个账号；不需要两台设备在同一网络。</div>
              <button type="button" onClick={() => void signOut()}>
                退出登录
              </button>
            </>
          ) : (
            <>
              <div className="meta">登录后可在不同网络下使用云端连接；局域网扫码不需要账号。</div>
              <button type="button" onClick={() => void signIn()} disabled={busy !== ""}>
                登录 Reasonix 账号
              </button>
            </>
          )}
          {grant ? (
            <div className="grant">
              <div className="meta">在应用内登录页登录后，回到这里等待完成；也可以手动输入：</div>
              <div className="code">{grant.userCode}</div>
              <button type="button" onClick={() => openLoginPage(grant.verificationUriComplete)}>
                打开登录页
              </button>
              <button type="button" onClick={() => setGrant(null)}>
                取消
              </button>
            </div>
          ) : null}
        </div>

        {account.signedIn && devices.length > 0 ? (
          <div className="card account">
            <h2>云端电脑</h2>
            <div className="meta">同一账号下开启了远程访问的电脑。</div>
            {devices.map((device) => {
              const ready =
                !Array.isArray(device.capabilities) || device.capabilities.includes("desktop");
              return (
                <button
                  key={device.id}
                  type="button"
                  disabled={busy !== "" || !ready}
                  onClick={() => void connectCloud(device.id)}
                >
                  {device.name ?? device.id}
                  {device.platform ? ` · ${device.platform}` : ""}
                  {ready ? "" : "（未开启远程访问）"}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
