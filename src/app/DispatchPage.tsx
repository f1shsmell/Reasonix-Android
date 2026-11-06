import { useCallback, useEffect, useRef, useState } from "react";
import type { TreeProject } from "../wire/tree";
import { effortChoices, effortDisplayName, loadGlobalModels, modelShortName } from "../net/models";
import type { ModelCatalog, ModelOption } from "../net/models";
import { speechSupported } from "../native/speech";
import { useDictation } from "../chat/dictation";
import { MicButton, VoiceLive } from "../chat/MicButton";
import { DispatchModelSheet } from "./DispatchModelSheet";

export interface DispatchOptions {
  model?: string;
  effort?: string;
}

export interface DispatchResult {
  ok: boolean;
  message?: string;
  runtimeId?: string;
  root?: string;
  title?: string;
}

export function DispatchPage({
  projects,
  computerName,
  notify,
  onDispatch,
  onSent,
}: {
  projects: TreeProject[];
  computerName?: string | undefined;
  /** The native watcher only reaches a LAN proxy; cloud has no background read. */
  notify: boolean;
  onDispatch: (
    root: string,
    prompt: string,
    options?: DispatchOptions,
  ) => Promise<DispatchResult>;
  onSent: (result: DispatchResult) => void;
}) {
  const usable = projects.filter((project) => project.missing !== true);
  const [root, setRoot] = useState(usable[0]?.root ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The tree can arrive after the tab opens. Adopt the first usable project
  // then, and fall back if the chosen one disappears.
  const firstRoot = usable[0]?.root ?? "";
  useEffect(() => {
    if (!firstRoot) {
      if (root) setRoot("");
      return;
    }
    if (!usable.some((project) => project.root === root)) setRoot(firstRoot);
  }, [firstRoot, projects, root, usable]);

  const grow = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }, []);

  const voiceText = useCallback((spoken: string) => {
    setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
    requestAnimationFrame(() => {
      grow();
      inputRef.current?.focus();
    });
  }, [grow, setText]);
  const { session: voice, down, move, up, cancel: cancelVoice } = useDictation({
    onText: voiceText,
    onError: setVoiceError,
  });

  const openModels = () => {
    setModelsOpen(true);
    if (catalog || modelsLoading) return;
    setModelsLoading(true);
    setModelsError("");
    void loadGlobalModels().then((result) => {
      setModelsLoading(false);
      if (!result.ok) {
        setModelsError(`读不到模型列表（${result.code}）。`);
        return;
      }
      setCatalog(result.catalog);
      const pick =
        result.catalog.models.find((option) => option.active)
        ?? result.catalog.models.find((option) => option.default)
        ?? result.catalog.models[0];
      if (pick) {
        setModel(pick.ref);
        setEffort(pick.effort ?? (effortChoices(pick).length > 0 ? "auto" : ""));
      }
    });
  };

  const pickModel = (option: ModelOption) => {
    setModel(option.ref);
    setEffort(option.effort ?? (effortChoices(option).length > 0 ? "auto" : ""));
  };

  const selectedModel = catalog?.models.find((option) => option.ref === model);
  const modelLabel = selectedModel ? modelShortName(selectedModel) : "默认模型";
  const chip = `${modelLabel}${effort ? ` · ${effortDisplayName(effort)}` : ""}`;

  const send = async () => {
    const prompt = text.trim();
    if (!root || !prompt || busy) return;
    setBusy(true);
    setError("");
    try {
      const chosen = {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
      const result = model || effort
        ? await onDispatch(root, prompt, chosen)
        : await onDispatch(root, prompt);
      if (result.ok) {
        const title = result.title ?? (prompt.split("\n", 1)[0] ?? "").trim();
        setText("");
        setSent(title ? `已派发：${title}` : "已派发，任务在后台运行。");
        onSent({
          ...result,
          root: result.root ?? root,
          title,
        });
        return;
      }
      setError(result.message ?? "没派出去，稍后再试。");
    } catch {
      setError("没派出去，稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dispatch-page" aria-label="派发任务">
      <div className="dispatch-scroll">
        <header className="dispatch-head">
          <h1>派发任务</h1>
          <p>选一个项目，描述要它做的事；派发后在电脑后台运行。</p>
        </header>

        <p className="field-label">项目</p>
        <div className="dispatch-projects" role="listbox" aria-label="项目">
          {usable.map((project) => (
            <button
              key={project.root}
              type="button"
              role="option"
              aria-selected={project.root === root}
              className={`dispatch-project${project.root === root ? " on" : ""}`}
              onClick={() => {
                setRoot(project.root);
                setSent("");
              }}
            >
              {project.name}
            </button>
          ))}
        </div>

        {usable.length === 0 ? (
          <div className="notice">
            <div>还没有可选的项目</div>
            <div className="meta">先在桌面端打开一个项目，再回来派发。</div>
          </div>
        ) : null}

        {error ? <div className="notice error">{error}</div> : null}
        {sent ? <div className="dispatch-sent" role="status">{sent}</div> : null}

        <div className="dispatch-hint">
          <span className="dot ok" aria-hidden="true" />
          <div>
            <b>{computerName ?? "这台电脑"}</b>
            <br />
            {notify
              ? "任务在电脑后台运行；需要你处理或完成时会通知。"
              : "云端连接暂不支持后台通知，完成后回来查看。"}
          </div>
        </div>
      </div>

      <div className="dispatch-composer">
        <VoiceLive session={voice} onCancel={cancelVoice} />
        {voiceError ? <div className="dispatch-voice-error">{voiceError}</div> : null}
        <textarea
          ref={inputRef}
          className="dispatch-input"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSent("");
            grow();
          }}
          placeholder="描述要它做的事"
          rows={1}
          enterKeyHint="enter"
        />
        <div className="dispatch-tools">
          <button
            type="button"
            className="modelchip"
            onClick={openModels}
            aria-label="切换模型与思考等级"
            title="切换模型与思考等级"
          >
            {chip}
          </button>
          {speechSupported() ? (
            <MicButton
              session={voice}
              disabled={busy}
              down={down}
              move={move}
              up={up}
            />
          ) : null}
          <button
            type="button"
            className="dispatch-send"
            onClick={() => void send()}
            disabled={busy || !root || text.trim() === ""}
          >
            {busy ? "正在派发…" : "派发"}
          </button>
        </div>
      </div>

      {modelsOpen ? (
        <DispatchModelSheet
          catalog={catalog}
          loading={modelsLoading}
          error={modelsError}
          model={model}
          effort={effort}
          onPickModel={pickModel}
          onEffort={setEffort}
          onClose={() => setModelsOpen(false)}
        />
      ) : null}
    </section>
  );
}

