/**
 * Choosing the model this conversation runs on.
 *
 * A phone is the worst place to discover you are on the wrong model: the
 * answer is slow, or refuses a screenshot, and the only fix used to be walking
 * to the desk. The catalog is per pane (`GET /rt/{id}/models`), and switching
 * is `POST /rt/{id}/model` — this conversation only. The desktop's default is
 * a different setting and is deliberately not touched here.
 *
 * The sheet is read-on-open: a catalog can change while the app sits on a
 * screen (a provider added on the desktop, a key revoked), and a cached list
 * would offer a model that now refuses.
 */

import { useCallback, useEffect, useState } from "react";
import { useBackCloser } from "../app/backStack";
import { currentModel, effortChoices, loadModels, modelShortName, switchEffort, switchModel } from "../net/models";
import type { ModelCatalog, ModelOption } from "../net/models";
import { loadStatus } from "../net/status";

export interface ModelSheetProps {
  /** The runtime's request prefix, e.g. `/rt/r1`. */
  base: string;
  /** The model the transcript last reported, shown while the catalog loads. */
  fallback?: string;
  onClose: () => void;
  /** The switch landed; the caller re-reads status and shows the new name. */
  onSwitched: (ref: string) => void;
}

function message(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "models.shape":
      return "桌面端返回了无法识别的模型列表。";
    case "provider.key_missing":
      return "这个模型还没有配置 API key，去桌面端补上再用。";
    case "model.unknown":
      return "桌面端不认识这个模型。";
    case "model.busy":
      return "这一轮还在跑，等它停下再换。";
    case "settings.default_model_brokered":
      return "这个会话的模型由它所连的电脑决定。";
    default:
      return `换不了：${code}`;
  }
}

function price(option: ModelOption): string {
  const window = option.contextWindow;
  if (!window) return "";
  return window >= 1000 ? `${Math.round(window / 1000)}K 上下文` : `${window} 上下文`;
}

function facts(option: ModelOption): string {
  const parts = [price(option)];
  if (option.vision) parts.push("看图");
  if (option.efforts && option.efforts.length > 0) parts.push(`思考 ${option.efforts.join("/")}`);
  return parts.filter(Boolean).join(" · ");
}

export function ModelSheet({ base, fallback, onClose, onSwitched }: ModelSheetProps) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  /** The effort this conversation is on; empty is the kernel's "let it decide". */
  const [effort, setEffort] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useBackCloser(true, onClose);

  useEffect(() => {
    let cancelled = false;
    void loadModels(base).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(message(result.code));
        return;
      }
      setCatalog(result.catalog);
    });
    // The effort is a separate read: `/models` declares what a model offers,
    // `/status` says which one this conversation is actually on.
    void loadStatus(base).then((result) => {
      if (cancelled || !result.ok) return;
      setEffort(result.status.effort ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const pick = useCallback(
    async (ref: string) => {
      if (busy) return;
      setBusy(ref);
      setError("");
      const result = await switchModel(base, ref);
      setBusy("");
      if (!result.ok) {
        setError(message(result.code));
        return;
      }
      onSwitched(ref);
    },
    [base, busy, onSwitched],
  );

  const active = catalog ? catalog.current : fallback ?? "";
  const activeOption = catalog?.models.find((option) => option.ref === active);
  const choices = effortChoices(activeOption);

  const pickEffort = useCallback(
    async (next: string) => {
      if (busy) return;
      setBusy(`effort:${next}`);
      setError("");
      const result = await switchEffort(base, next);
      setBusy("");
      if (!result.ok) {
        setError(message(result.code));
        return;
      }
      setEffort(next === "auto" ? "" : next);
    },
    [base, busy],
  );

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="选择模型"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>模型</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {error ? <div className="notice error">{error}</div> : null}

        {/* Effort belongs to the model that declares it: a model with no
            efforts cannot be asked for one, and offering the control would be
            a tap the kernel refuses. */}
        {choices.length > 0 ? (
          <>
            <p className="sheet-label">思考强度</p>
            <div className="segmented" role="group" aria-label="思考强度">
              {choices.map((choice) => {
                const selected = choice === "auto" ? effort === "" : effort === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    className={selected ? "on" : ""}
                    aria-pressed={selected}
                    disabled={busy !== ""}
                    onClick={() => void pickEffort(choice)}
                  >
                    {busy === `effort:${choice}` ? "…" : choice}
                  </button>
                );
              })}
            </div>
            <p className="meta sheet-note">
              只影响下一个回合；auto 让模型自己决定。
            </p>
          </>
        ) : null}

        {catalog === null && !error ? <div className="meta">正在读取可选模型…</div> : null}

        {catalog !== null && catalog.models.length === 0 ? (
          <div className="meta">这台电脑没有可切换的模型。</div>
        ) : null}

        {catalog !== null && catalog.models.length > 0 ? (
          <ul className="list">
            {catalog.models.map((option) => {
              const selected = option.ref === active || (option.active && !active);
              const detail = facts(option);
              return (
                <li key={option.ref}>
                  <button
                    type="button"
                    className={`model-row${selected ? " on" : ""}`}
                    onClick={() => void pick(option.ref)}
                    disabled={busy !== "" || selected}
                    aria-pressed={selected}
                  >
                    <span className="row-main">
                      <span className="model-name">
                        {modelShortName(option)}
                        {option.default ? <span className="pill">默认</span> : null}
                      </span>
                      <span className="model-provider">
                        {option.displayName || option.provider}
                        {detail ? ` · ${detail}` : ""}
                      </span>
                    </span>
                    <span className="model-mark" aria-hidden="true">
                      {busy === option.ref ? "…" : selected ? "✓" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {catalog !== null ? (
          <p className="meta sheet-note">
            只换这一个会话；桌面端的默认模型不变。当前：
            {currentModel(catalog) || "未知"}。
          </p>
        ) : null}
      </section>
    </div>
  );
}
