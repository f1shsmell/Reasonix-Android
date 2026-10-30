/**
 * Drawing a structured ask: the kernel's `surface` instead of options.
 *
 * A question may carry a `surface` — a small declarative UI — instead of a list
 * of labels. Such a question has no `options`, and its answer is not a list of
 * pickable strings: it is an object of field values sent under `Value`, with
 * `Selected` empty. Rendering it through the option path is what produced the
 * "这个问题没有可选项" card that could not be answered at all.
 *
 * Two kinds of node live in a surface, and they are handled differently:
 *
 * - **Inputs** (`field`, `choice_card`, `editable_text`, `map`, `comparison`)
 *   own a `key` and a `field`, and their values make up the answer. Every
 *   required one must be filled before the form can be sent.
 * - **Display** nodes (`text`, `kv`, `pip`, `meter`, `diff_preview`,
 *   `dashboard`) only show something. They are worth drawing because they are
 *   often the reason the question is being asked, but they answer nothing.
 *
 * A `button` is an action, not a field: the kernel validates it against the
 * spec's own action table, and answering is a separate call. This client
 * therefore shows buttons as labels and sends the form's field values — a
 * single answer carrying `Value`. Buttons that would need their own request
 * are out of scope until the kernel exposes that route for a device.
 */

import { useMemo, useState } from "react";
import type { SurfaceField, SurfaceNode, SurfaceOption, SurfaceSpec } from "../wire/surface";
import { surfaceFields, parseSurface } from "../wire/surface";

export type SurfaceValues = Record<string, unknown>;

export interface SurfaceCardProps {
  /** The raw `surface` payload from the question. */
  surface: unknown;
  /** False once the ask is settled elsewhere; the form turns into a record. */
  pending: boolean;
  onAnswer: (values: SurfaceValues) => void;
}

/** A field's starting value: the declared default, else empty by type. */
function initialValue(field: SurfaceField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "number":
      return "";
    case "bool":
      return false;
    case "multichoice":
      return [];
    default:
      return "";
  }
}

function initialValues(nodes: SurfaceNode[]): SurfaceValues {
  const out: SurfaceValues = {};
  for (const [key, field] of surfaceFields(nodes)) {
    out[key] = initialValue(field);
  }
  return out;
}

/** Whether one field has an answer. `false` for a bool is an answer. */
function filled(field: SurfaceField, value: unknown): boolean {
  switch (field.type) {
    case "bool":
      return true;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "multichoice":
      return Array.isArray(value) && value.length > 0;
    default:
      return typeof value === "string" && value.trim() !== "";
  }
}

export function surfaceReady(nodes: SurfaceNode[], values: SurfaceValues): boolean {
  for (const [key, field] of surfaceFields(nodes)) {
    if (field.required === true && !filled(field, values[key])) return false;
  }
  return true;
}

function toneClass(tone: string | undefined): string {
  return tone ? ` surface-tone-${tone}` : "";
}

function DisplayNode({ node }: { node: SurfaceNode }) {
  switch (node.kind) {
    case "text":
      return <p className={`surface-text${toneClass(node.tone)}`}>{node.value}</p>;
    case "markdown":
      // Rendered as plain text on purpose: this client's Markdown path is for
      // finished assistant answers, and a surface is untrusted structure from
      // the model. Text keeps it inert.
      return <p className={`surface-text${toneClass(node.tone)}`}>{node.value}</p>;
    case "kv":
      return (
        <div className="surface-kv">
          <span className="surface-kv-key">{node.key}</span>
          <span className={`surface-kv-value${toneClass(node.tone)}`}>{node.value ?? ""}</span>
        </div>
      );
    case "pip":
      return <span className={`surface-pip${toneClass(node.tone)}`} aria-hidden="true" />;
    case "meter": {
      const progress = Math.max(0, Math.min(1, node.progress ?? 0));
      return (
        <div className="surface-meter" role="meter" aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0} aria-valuemax={100} aria-label={node.label ?? ""}>
          {node.label ? <span className="surface-meter-label">{node.label}</span> : null}
          <span className="surface-meter-track">
            <span className={`surface-meter-fill${toneClass(node.tone)}`} style={{ width: `${progress * 100}%` }} />
          </span>
        </div>
      );
    }
    case "divider":
      return <div className="surface-divider" role="separator" />;
    case "diff_preview":
      return (
        <details className="surface-diff">
          <summary>{node.label ?? "改动"}</summary>
          <pre className="out diff">
            <span className="line meta">{"--- 之前\n"}</span>
            {node.diff?.before ?? ""}
            <span className="line meta">{"\n+++ 之后\n"}</span>
            {node.diff?.after ?? ""}
          </pre>
        </details>
      );
    case "dashboard": {
      const dataset = node.dataset;
      if (!dataset) return null;
      // A bar per category, scaled to the largest value across series. A phone
      // cannot read a real chart, and a table of numbers would be worse.
      const peak = Math.max(1, ...dataset.series.flatMap((series) => series.values.map(Math.abs)));
      return (
        <div className="surface-dashboard">
          {node.label ? <span className="surface-dash-label">{node.label}</span> : null}
          {dataset.categories.map((category, index) => (
            <div className="surface-dash-row" key={category}>
              <span className="surface-dash-cat">{category}</span>
              <span className="surface-dash-bars">
                {dataset.series.map((series) => {
                  const value = series.values[index] ?? 0;
                  return (
                    <span
                      className="surface-dash-bar"
                      key={series.id}
                      style={{ width: `${(Math.abs(value) / peak) * 100}%` }}
                      title={`${series.label ?? series.id}: ${value}${series.unit ?? ""}`}
                    />
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      );
    }
    case "row":
    case "stack":
      // Reached only when a layout node carries no children; `RenderNode`
      // handles the real case with values and handlers in hand.
      return null;
    case "button":
      // Shown, not pressed: a button is an action the kernel validates against
      // its own table, and this client's answer carries field values only.
      return <div className="surface-action">{node.label}</div>;
    default:
      return null;
  }
}

function FieldInput({
  node,
  field,
  value,
  pending,
  onChange,
}: {
  node: SurfaceNode;
  field: SurfaceField;
  value: unknown;
  pending: boolean;
  onChange: (next: unknown) => void;
}) {
  const label = node.label ?? node.key ?? "";
  const disabled = !pending;

  switch (field.type) {
    case "choice":
    case "multichoice": {
      const multi = field.type === "multichoice";
      const chosen = multi
        ? Array.isArray(value)
          ? (value as string[])
          : []
        : typeof value === "string"
          ? [value]
          : [];
      const options = field.options ?? [];
      return (
        <div className="surface-field">
          <span className="surface-field-label">
            {label}
            {field.required ? <span className="surface-required">*</span> : null}
          </span>
          <div className={node.kind === "choice_card" ? "surface-cards" : "surface-choices"}>
            {options.map((option: SurfaceOption) => {
              const active = chosen.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={active ? "chosen" : undefined}
                  aria-pressed={multi ? active : undefined}
                  disabled={disabled}
                  onClick={() => {
                    if (multi) {
                      onChange(
                        active ? chosen.filter((entry) => entry !== option.value) : [...chosen, option.value],
                      );
                    } else {
                      onChange(option.value);
                    }
                  }}
                >
                  {option.label}
                  {option.description ? <small>{option.description}</small> : null}
                  {option.preview ? <small className="surface-preview">{option.preview}</small> : null}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    case "number":
      return (
        <label className="surface-field">
          <span className="surface-field-label">
            {label}
            {field.required ? <span className="surface-required">*</span> : null}
          </span>
          <input
            type="number"
            inputMode="decimal"
            value={typeof value === "number" ? String(value) : ""}
            min={field.min}
            max={field.max}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(raw === "" ? "" : Number(raw));
            }}
          />
        </label>
      );
    case "bool":
      return (
        <label className="surface-field surface-bool">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="surface-field-label">{label}</span>
        </label>
      );
    default:
      return (
        <label className="surface-field">
          <span className="surface-field-label">
            {label}
            {field.required ? <span className="surface-required">*</span> : null}
          </span>
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            maxLength={field.maxLength}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      );
  }
}

function RenderNode({
  node,
  values,
  onChange,
  pending,
}: {
  node: SurfaceNode;
  values: SurfaceValues;
  onChange: (key: string, next: unknown) => void;
  pending: boolean;
}) {
  if (node.field && node.key) {
    // `row`/`stack` may nest inputs; every other input kind stands alone.
    return (
      <FieldInput
        node={node}
        field={node.field}
        value={values[node.key]}
        pending={pending}
        onChange={(next) => onChange(node.key as string, next)}
      />
    );
  }
  if (node.children && node.children.length > 0) {
    return (
      <div className={node.kind === "row" ? "surface-row" : "surface-stack"}>
        {node.children.map((child, index) => (
          <RenderNode key={index} node={child} values={values} onChange={onChange} pending={pending} />
        ))}
      </div>
    );
  }
  return <DisplayNode node={node} />;
}

export function SurfaceCard({ surface, pending, onAnswer }: SurfaceCardProps) {
  const spec: SurfaceSpec | null = useMemo(() => parseSurface(surface), [surface]);
  const [values, setValues] = useState<SurfaceValues>(() =>
    spec ? initialValues(spec.body) : {},
  );

  if (!spec) return null;

  const change = (key: string, next: unknown) => {
    setValues((current) => ({ ...current, [key]: next }));
  };
  const ready = surfaceReady(spec.body, values);

  return (
    <div className="surface">
      {spec.title ? <div className="surface-title">{spec.title}</div> : null}
      <div className="surface-body">
        {spec.body.map((node, index) => (
          <RenderNode key={index} node={node} values={values} onChange={change} pending={pending} />
        ))}
      </div>
      {pending ? (
        <button type="button" className="confirm" disabled={!ready} onClick={() => onAnswer(values)}>
          确认
        </button>
      ) : (
        <div className="answered">已结束，不用再答</div>
      )}
    </div>
  );
}
