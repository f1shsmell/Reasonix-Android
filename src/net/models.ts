/**
 * The models one conversation can be switched onto.
 *
 * `GET /rt/{id}/models` answers the picker the desktop already uses: the
 * catalog this pane can actually reach, which model is active, and which one
 * new conversations start on. `POST /rt/{id}/model {ref}` switches this pane
 * and nothing else — the desktop's default is a different setting, and a
 * phone that silently changed it would re-point the person's next session.
 *
 * The catalog is per pane rather than per machine because a relayed pane
 * resolves models on the machine it proxies to.
 */

import { fetchWithTimeout } from "./http";

export interface ModelOption {
  ref: string;
  provider: string;
  model: string;
  displayName?: string;
  active: boolean;
  default: boolean;
  vision?: boolean;
  efforts?: string[];
  effort?: string;
  contextWindow?: number;
}

export interface ModelCatalog {
  /** The ref this conversation is on now. */
  current: string;
  /** A human label for `current`, when the kernel has one. */
  label: string;
  /** What a new conversation starts on. */
  default: string;
  models: ModelOption[];
}

export type ModelsRead =
  | { ok: true; catalog: ModelCatalog }
  | { ok: false; code: string };

function option(value: unknown, current: string): ModelOption | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const ref = typeof row.ref === "string" ? row.ref.trim() : "";
  if (!ref) return null;
  const out: ModelOption = {
    ref,
    provider: typeof row.provider === "string" ? row.provider : "",
    model: typeof row.model === "string" && row.model ? row.model : ref,
    active: row.active === true || ref === current,
    default: row.default === true,
  };
  if (typeof row.displayName === "string" && row.displayName) out.displayName = row.displayName;
  if (row.vision === true) out.vision = true;
  if (Array.isArray(row.efforts)) {
    const efforts = row.efforts.filter((entry): entry is string => typeof entry === "string");
    if (efforts.length > 0) out.efforts = efforts;
  }
  if (typeof row.effort === "string" && row.effort) out.effort = row.effort;
  if (typeof row.contextWindow === "number" && row.contextWindow > 0) {
    out.contextWindow = row.contextWindow;
  }
  return out;
}

async function failureCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (body && typeof body === "object" && typeof body.code === "string") return body.code;
  } catch {
    // A refusal that is not JSON still has an HTTP status.
  }
  return `http.${response.status}`;
}

export async function loadModels(base: string): Promise<ModelsRead> {
  try {
    const response = await fetchWithTimeout(`${base}/models`, { credentials: "same-origin" }, 15_000);
    if (!response.ok) return { ok: false, code: await failureCode(response) };
    const body = (await response.json()) as Record<string, unknown>;
    if (body === null || typeof body !== "object") return { ok: false, code: "models.shape" };
    const current = typeof body.current === "string" ? body.current : "";
    const models = Array.isArray(body.models)
      ? body.models
          .map((entry) => option(entry, current))
          .filter((entry): entry is ModelOption => entry !== null)
      : [];
    return {
      ok: true,
      catalog: {
        current,
        label: typeof body.label === "string" ? body.label : "",
        default: typeof body.default === "string" ? body.default : "",
        models,
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * The machine's whole chat catalog, before a pane exists.
 *
 * Dispatch creates its runtime only on send, so there is no `/rt/{id}/models`
 * to read while the composer is being filled. The machine endpoint answers
 * the same entries at `/models?answers=chat`; the active/default flags pick
 * the row a fresh pane would start on.
 */
export async function loadGlobalModels(): Promise<ModelsRead> {
  try {
    const response = await fetchWithTimeout(
      "/models?answers=chat",
      { credentials: "same-origin" },
      15_000,
    );
    if (!response.ok) return { ok: false, code: await failureCode(response) };
    const body = (await response.json()) as unknown;
    const rows = Array.isArray(body)
      ? body
      : body !== null && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
        ? ((body as { models: unknown[] }).models)
        : [];
    const models = rows
      .map((entry) => option(entry, ""))
      .filter((entry): entry is ModelOption => entry !== null);
    const current = models.find((entry) => entry.active)?.ref
      ?? models.find((entry) => entry.default)?.ref
      ?? models[0]?.ref
      ?? "";
    const active = models.find((entry) => entry.ref === current);
    return {
      ok: true,
      catalog: {
        current,
        label: active?.displayName ?? active?.model ?? "",
        default: models.find((entry) => entry.default)?.ref ?? "",
        models,
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

export type ModelSwitch =
  | { ok: true }
  | { ok: false; code: string };

/** Switch this conversation's model. The next turn runs on it. */
export async function switchModel(base: string, ref: string): Promise<ModelSwitch> {
  const target = ref.trim();
  if (!target) return { ok: false, code: "client.empty_ref" };
  try {
    const response = await fetchWithTimeout(
      `${base}/model`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ref: target }),
      },
      30_000,
    );
    if (response.ok) return { ok: true };
    return { ok: false, code: await failureCode(response) };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * How hard the model should think on the next turn.
 *
 * `effort` is per conversation, not a machine default: the phone changing it
 * must not re-point what the desktop's next session runs on. An empty string
 * is the kernel's own word for "let the model decide" — the display test there
 * asserts that `auto` round-trips as empty — so this sends it as given rather
 * than inventing a value.
 */
export async function switchEffort(base: string, effort: string): Promise<ModelSwitch> {
  try {
    const response = await fetchWithTimeout(
      `${base}/effort`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ effort }),
      },
      20_000,
    );
    if (response.ok) return { ok: true };
    return { ok: false, code: await failureCode(response) };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * The effort choices for one model, with "auto" first.
 *
 * A model that declares no efforts cannot be asked for one, so the list is
 * empty and the sheet hides the section rather than offering a control that
 * would be refused.
 */
export function effortChoices(model: ModelOption | undefined): string[] {
  if (!model || !model.efforts || model.efforts.length === 0) return [];
  return ["auto", ...model.efforts.filter((entry) => entry !== "auto")];
}

/**
 * The reasoning-effort level as a person reads it, for chips and sheets.
 * Raw wire values stay for the control itself; the display never shows them.
 */
export function effortDisplayName(value: string): string {
  switch (value) {
    case "auto": return "自动";
    case "low": return "低";
    case "medium": return "中";
    case "high": return "高";
    case "max": return "最高";
    default: return value;
  }
}

/** The short name a chip shows: the model, not `provider/model`. */
export function modelShortName(model: ModelOption): string {
  return model.model || model.ref;
}

/** The active option, or the ref alone when the catalog has no row for it. */
export function currentModel(catalog: ModelCatalog): string {
  const active = catalog.models.find((entry) => entry.active);
  if (active) return modelShortName(active);
  return catalog.label || catalog.current;
}
