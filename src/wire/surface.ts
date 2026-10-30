/**
 * The kernel's structured ask surface, as JSON.
 *
 * A question may carry a `surface` instead of `options`. When it does, the
 * answer is not a list of labels: it is an object of field values sent under
 * `Value`, with `Selected` empty. That is why a surface question rendered with
 * the option path showed "这个问题没有可选项" and could not be answered.
 *
 * Only the node kinds this client draws are named. An unknown kind is skipped
 * rather than crashing the transcript — the kernel may grow one, and a phone
 * that cannot draw a card must still let the person answer the rest.
 */

export interface SurfaceOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
  /** Which group a map/choice card belongs to, e.g. "Day 1". */
  group?: string;
}

export interface SurfaceField {
  type: string;
  required?: boolean;
  /** The prefilled value, in the field's own JSON type. */
  default?: unknown;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: SurfaceOption[];
}

export interface SurfaceDiff {
  before: string;
  after: string;
}

export interface SurfaceSeries {
  id: string;
  label?: string;
  unit?: string;
  values: number[];
}

export interface SurfaceDataset {
  categories: string[];
  series: SurfaceSeries[];
}

export interface SurfaceNode {
  kind: string;
  value?: string;
  key?: string;
  label?: string;
  tone?: string;
  /** 0..1 for a meter. */
  progress?: number;
  actionId?: string;
  children?: SurfaceNode[];
  field?: SurfaceField;
  diff?: SurfaceDiff;
  dataset?: SurfaceDataset;
}

export interface SurfaceSpec {
  specVersion: number;
  title?: string;
  body: SurfaceNode[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function option(value: unknown): SurfaceOption | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.value !== "string" || !row.value) return null;
  const out: SurfaceOption = { value: row.value, label: str(row.label) ?? row.value };
  const description = str(row.description);
  if (description !== undefined) out.description = description;
  const preview = str(row.preview);
  if (preview !== undefined) out.preview = preview;
  const group = str(row.group);
  if (group !== undefined) out.group = group;
  return out;
}

function field(value: unknown): SurfaceField | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const type = str(row.type);
  if (!type) return null;
  const out: SurfaceField = { type };
  if (row.required === true) out.required = true;
  if (row.default !== undefined) out.default = row.default;
  const min = num(row.min);
  if (min !== undefined) out.min = min;
  const max = num(row.max);
  if (max !== undefined) out.max = max;
  if (typeof row.max_length === "number" && row.max_length > 0) out.maxLength = row.max_length;
  if (Array.isArray(row.options)) {
    const options = row.options.map(option).filter((entry): entry is SurfaceOption => entry !== null);
    if (options.length > 0) out.options = options;
  }
  return out;
}

function diff(value: unknown): SurfaceDiff | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.before !== "string" || typeof row.after !== "string") return undefined;
  return { before: row.before, after: row.after };
}

function dataset(value: unknown): SurfaceDataset | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.categories) || !Array.isArray(row.series)) return undefined;
  const categories = row.categories.filter((entry): entry is string => typeof entry === "string");
  const series = row.series.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const s = entry as Record<string, unknown>;
    if (typeof s.id !== "string" || !Array.isArray(s.values)) return [];
    const values = s.values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const out: SurfaceSeries = { id: s.id, values };
    const label = str(s.label);
    if (label !== undefined) out.label = label;
    const unit = str(s.unit);
    if (unit !== undefined) out.unit = unit;
    return [out];
  });
  if (categories.length === 0 || series.length === 0) return undefined;
  return { categories, series };
}

export function parseNode(value: unknown): SurfaceNode | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = str(row.kind);
  if (!kind) return null;
  const out: SurfaceNode = { kind };
  // Each optional field is read once into a local: `exactOptionalPropertyTypes`
  // refuses a second `str(...)` call because it cannot see the narrowing.
  const text = str(row.value);
  if (text !== undefined) out.value = text;
  const key = str(row.key);
  if (key !== undefined) out.key = key;
  const label = str(row.label);
  if (label !== undefined) out.label = label;
  const tone = str(row.tone);
  if (tone !== undefined) out.tone = tone;
  const progress = num(row.progress);
  if (progress !== undefined) out.progress = progress;
  const actionId = str(row.actionId);
  if (actionId !== undefined) out.actionId = actionId;
  if (Array.isArray(row.children)) {
    const children = row.children
      .map(parseNode)
      .filter((entry): entry is SurfaceNode => entry !== null);
    if (children.length > 0) out.children = children;
  }
  const parsedField = field(row.field);
  if (parsedField) out.field = parsedField;
  const parsedDiff = diff(row.diff);
  if (parsedDiff) out.diff = parsedDiff;
  const parsedDataset = dataset(row.dataset);
  if (parsedDataset) out.dataset = parsedDataset;
  return out;
}

export function parseSurface(value: unknown): SurfaceSpec | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.body)) return null;
  const body = row.body.map(parseNode).filter((entry): entry is SurfaceNode => entry !== null);
  if (body.length === 0) return null;
  const spec: SurfaceSpec = {
    specVersion: typeof row.spec_version === "number" ? row.spec_version : 1,
    body,
  };
  const title = str(row.title);
  if (title !== undefined) spec.title = title;
  return spec;
}

/** Every field in a surface, by key — a form's inputs, wherever they nest. */
export function surfaceFields(nodes: SurfaceNode[]): Map<string, SurfaceField> {
  const out = new Map<string, SurfaceField>();
  const walk = (list: SurfaceNode[]) => {
    for (const node of list) {
      if (node.field && node.key) out.set(node.key, node.field);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** A button a surface offers: its label and the action it names. */
export function surfaceButtons(nodes: SurfaceNode[]): { label: string; actionId: string }[] {
  const out: { label: string; actionId: string }[] = [];
  const walk = (list: SurfaceNode[]) => {
    for (const node of list) {
      if (node.kind === "button" && node.label && node.actionId) {
        out.push({ label: node.label, actionId: node.actionId });
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
