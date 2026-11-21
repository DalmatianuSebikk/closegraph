/**
 * Source window model (source-window plan Task 2). Pure reducer from a
 * fileSource rpc payload + key/dims events to renderable rows/state.
 * No OpenTUI imports — headless-testable, same family as the entry model.
 *
 * Honesty rules: `rows` mirror the payload window verbatim (n = true line
 * number, firstLine-based); the footer discloses rpc-side truncation
 * (`N not shown` = totalLines − lines.length, NEVER the visible-slice size —
 * the route windows rows separately). Anchor lands the span start two rows
 * below the top edge, once, on ready; scroll then belongs to the user.
 * Load failures never reject: they land in an error state that keeps the file.
 */
import type { FileSourcePayload, SourceSpan } from "../../rpc/index.js";
import type { Dims } from "./file-map-model.js";

export interface SourceRow {
  /** true line number (firstLine-based) */
  n: number;
  text: string;
  inSpan: boolean;
}

export type SourceWindowState =
  | { status: "closed" }
  | { status: "loading"; file: string }
  | { status: "error"; file: string; message: string }
  | {
      status: "ready";
      file: string;
      lines: string[];
      firstLine: number;
      totalLines: number;
      truncated: boolean;
      span?: SourceSpan;
      /** the ref the window was opened for, echoed when its span resolved —
       *  the route's title shows its short name */
      ref?: string;
      rows: SourceRow[];
      anchorRow: number;
      scroll: number;
      footer: string;
    };

/** rows reserved by the overlay chrome: 2 border + title + footer + breathing room */
const RESERVED = 6;

export function createSourceWindowModel(deps: {
  fileSource: (input: { file: string; ref?: string }) => Promise<FileSourcePayload>;
}): {
  open(file: string, ref?: string): void;
  close(): void;
  move(delta: number): void;
  resize(dims: Dims): void;
  whenSettled(): Promise<void>;
  state(): SourceWindowState;
} {
  let dims: Dims = { width: 80, height: 24 };
  let state: SourceWindowState = { status: "closed" };
  let seq = 0;
  /** the latest open()'s promise — whenSettled() hands it to the route so a
   *  slow rpc gets a deterministic repaint (the whenEntrySettled family). */
  let pending: Promise<void> = Promise.resolve();

  const visible = () => Math.max(1, dims.height - RESERVED);
  const maxScroll = (rowCount: number) => Math.max(0, rowCount - visible());

  function buildReady(file: string, p: Extract<FileSourcePayload, { lines: string[] }>): SourceWindowState {
    const span = p.span;
    const rows: SourceRow[] = p.lines.map((text, i) => ({
      n: p.firstLine + i,
      text,
      inSpan: span !== undefined && p.firstLine + i >= span.startLine && p.firstLine + i <= span.endLine,
    }));
    const lastShown = p.firstLine + p.lines.length - 1;
    let footer = `${file} · ${p.firstLine}-${lastShown}/${p.totalLines} lines`;
    if (p.truncated === true) footer += ` · ${p.totalLines - p.lines.length} not shown`;
    if (span !== undefined) footer += ` · ${span.startLine}-${span.endLine} marked`;
    const ms = maxScroll(rows.length);
    const anchorRow = span !== undefined ? Math.max(0, Math.min(span.startLine - p.firstLine - 2, ms)) : 0;
    return {
      status: "ready",
      file,
      lines: p.lines,
      firstLine: p.firstLine,
      totalLines: p.totalLines,
      truncated: p.truncated === true,
      ...(span !== undefined ? { span } : {}),
      ...(span !== undefined && p.ref !== undefined ? { ref: p.ref } : {}),
      rows,
      anchorRow,
      scroll: anchorRow,
      footer,
    };
  }

  return {
    /** Fires the fetch and forgets it; a settle only lands if it is the newest.
     *  Resolves even when the settle was superseded — whenSettled() means "this
     *  call finished", not "its state applied". */
    open(file: string, ref?: string): void {
      const mySeq = ++seq;
      state = { status: "loading", file };
      pending = deps
        .fileSource({ file, ...(ref !== undefined ? { ref } : {}) })
        .then((p) => {
          if (seq !== mySeq) return;
          if ("error" in p) {
            state = { status: "error", file, message: "message" in p ? p.message : `no match for ${file}` };
            return;
          }
          state = buildReady(file, p);
        })
        .catch((err: unknown) => {
          if (seq !== mySeq) return;
          state = { status: "error", file, message: err instanceof Error ? err.message : String(err) };
        });
    },

    /** Resolves when the latest open() has settled (open without an in-flight
     *  call resolves immediately) — the route's repaint hook. */
    whenSettled(): Promise<void> {
      return pending;
    },

    /** Closes now and invalidates any in-flight settle. */
    close(): void {
      seq++;
      state = { status: "closed" };
    },

    /** Scroll by delta; no-op unless ready; clamped to the windowed rows. */
    move(delta: number): void {
      if (state.status !== "ready") return;
      state = { ...state, scroll: Math.max(0, Math.min(state.scroll + delta, maxScroll(state.rows.length))) };
    },

    /** Dims change re-windows (new visible budget) and re-clamps the scroll. */
    resize(next: Dims): void {
      if (next.width === dims.width && next.height === dims.height) return;
      dims = { ...next };
      if (state.status === "ready") {
        state = { ...state, scroll: Math.max(0, Math.min(state.scroll, maxScroll(state.rows.length))) };
      }
    },

    state(): SourceWindowState {
      return state;
    },
  };
}
