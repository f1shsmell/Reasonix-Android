import { useBackCloser } from "./backStack";
import { Segmented } from "./Segmented";
import { effortChoices, effortDisplayName, modelShortName } from "../net/models";
import type { ModelCatalog, ModelOption } from "../net/models";

/**
 * The model and reasoning level for one dispatched task.
 *
 * A dispatch has no pane until send, so this reads the machine catalog rather
 * than a conversation one. The choice is applied to the pane the dispatch
 * creates; it never changes the desktop's default.
 */
export function DispatchModelSheet({
  catalog,
  loading,
  error,
  model,
  effort,
  onPickModel,
  onEffort,
  onClose,
}: {
  catalog: ModelCatalog | null;
  loading: boolean;
  error: string;
  model: string;
  effort: string;
  onPickModel: (option: ModelOption) => void;
  onEffort: (effort: string) => void;
  onClose: () => void;
}) {
  useBackCloser(true, onClose);
  const selected = catalog?.models.find((option) => option.ref === model);
  const efforts = effortChoices(selected);
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet dispatch-model-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="模型与思考"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>模型与思考</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="group-note">只影响这次派发的任务，不改电脑上的默认模型。</p>

        {loading ? <div className="centered"><div>正在读取模型…</div></div> : null}
        {error ? <div className="notice error">{error}</div> : null}

        {catalog ? (
          <div className="dispatch-models" role="listbox" aria-label="模型">
            {catalog.models.map((option) => (
              <button
                key={option.ref}
                type="button"
                role="option"
                aria-selected={option.ref === model}
                className={`model-row${option.ref === model ? " on" : ""}`}
                onClick={() => onPickModel(option)}
              >
                <span className="model-name">{modelShortName(option)}</span>
                <span className="model-provider">
                  {[option.displayName || option.provider, option.contextWindow ? `${Math.round(option.contextWindow / 1000)}K` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {efforts.length > 0 ? (
          <div className="dispatch-effort">
            <span className="group-label">思考等级</span>
            <Segmented
              ariaLabel="思考等级"
              value={efforts.includes(effort) ? effort : "auto"}
              options={efforts.map((value) => ({ value, label: effortDisplayName(value) }))}
              onChange={onEffort}
            />
          </div>
        ) : null}

        <div className="sheet-foot">
          <button type="button" className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </section>
    </div>
  );
}
