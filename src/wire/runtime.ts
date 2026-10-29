/** One open pane, as the hub reports it on `GET /runtimes`. */
export interface RuntimeView {
  id: string;
  /** Request prefix every call for this pane carries, e.g. `/rt/ab12`. */
  base: string;
  /** Workspace root the pane has open. */
  root: string;
  name: string;
  sessionPath?: string;
  host?: string;
  /** Another process holds the write lease: readable, not writable. */
  readOnly?: boolean;
}
