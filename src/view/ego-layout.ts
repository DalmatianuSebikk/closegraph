/**
 * Ego-graph canvas layout (ego-graph-view plan Task 3): PURE fixed-geometry
 * composer — no OpenTUI imports, no dims input (the MODEL in ego-model.ts owns
 * windowing and the narrow-terminal collapse), no randomness, no clock. Same
 * input ⇒ same canvas byte-for-byte, so the render layer (Task 5) maps rows 1:1
 * onto height-1 `<text>` segments per the tui-render/ego-edges spikes.
 *
 * Geometry (spike E9 family, constants pinned by the plan):
 * - Canvas width is ALWAYS egoMinWidth() = 56: `[callers 16][gutter 4][center 16][gutter 4][callees 16]`.
 * - Boxes are 4 rows (border, label, detail, border); side columns stack top-down
 *   in input order with one blank row between boxes (pitch BOX_H + 1). The center
 *   column is vertically centered against the tallest side column:
 *   centerY = floor(tallest / 2), clamped so the box fits.
 * - Edge paths run from a neighbor's border mid-row (boxTop + 2) across the gutter
 *   into the arrow terminal beside the center's border. When the two mid-rows
 *   differ, the path bends in the gutter (┐/┘ at the anchor, │ between, └/┌ at
 *   the center row).
 *
 * Collision policy (brief ruling, Ruling-12 family) reconciled with the spike's
 * stroke-union algebra (ego-edges.md E1):
 * - Gutter cells merge by bitwise OR of 4-bit arm masks (U=1 D=2 L=4 R=8), so
 *   cohabiting strokes render as ├ ┤ ┬ ┴ ┼ (E1/E9: the ─×│ cross is ┼, joining
 *   turns union at the funnel row). The merge NEVER overwrites an arrowhead.
 * - A path is BLOCKED only where its own pure vertical (│) would overlap another
 *   edge's pure vertical — two indistinguishable parallel runs. Claims are taken
 *   in input order (code-unit sorted by the caller, Task 2); a loser spills to
 *   lane 2 (one char further from its box); if both lanes are blocked at any
 *   cell the edge is DROPPED and counted in `undrawnEdges` — disclosed, never
 *   silently missing.
 * - The two arrow terminals (▶ into the center's left border, ◀ out of its right
 *   border) are painted first and no path's stroke list ever includes their
 *   cells, so the center can never lose them.
 *
 * Text (spike E3): OpenTUI silently clips a <text> to its declared width, so this
 * module pads/truncates EVERY cell run itself — every segment's text length IS
 * its width, and every row's segments concatenate to exactly egoMinWidth().
 */
import type { RiskBucket } from "./risk.js";
import { RISK_SHADING } from "./file-map-model.js";

export interface EgoBox {
  ref: string;
  /** line 1: node short name (truncated to fit BOX_W - 2, "…" convention) */
  label: string;
  /** line 2: file path + counts, truncated the same way; may be "" */
  detail: string;
  /** RISK_SHADING marker ("" | "!" | "!!!") — rendered on the label line, fg red */
  marker: string;
  bucket: RiskBucket;
}

export interface EgoSegment {
  /** exact run of canvas characters — length IS the segment width (E3) */
  text: string;
  fg?: string;
  /** selection gray / risk bg (D4: shading NEVER via border props) */
  bg?: string;
  /** node hit-test target — set on segments inside a node box */
  ref?: string;
}

export interface EgoCanvas {
  /** one entry per canvas row; the render layer maps 1:1 to height-1 rows */
  rows: EgoSegment[][];
  /** always egoMinWidth() — the canvas is fixed-geometry */
  width: number;
  height: number;
  /** edges that could not be routed — disclosed, never silently missing */
  undrawnEdges: number;
}

export interface EgoLayoutInput {
  center: EgoBox;
  /** already capped + code-unit sorted by the caller (Task 2 order) */
  callers: EgoBox[];
  callees: EgoBox[];
  /** highlighted node — its box's interior segments get the selection bg */
  selectedRef?: string;
}

/** total box width incl. border columns (14-char interior) */
export const BOX_W = 16;
/** border top, 2 label rows, border bottom */
export const BOX_H = 4;
/** connector lanes between columns (2 lanes) */
export const GUTTER_W = 4;

/** 3 * BOX_W + 2 * GUTTER_W = 56 — the fixed canvas width and collapse threshold. */
export function egoMinWidth(): number {
  return 3 * BOX_W + 2 * GUTTER_W;
}

// --- stroke-union glyph algebra (spike E1: 4-bit arm masks) ---
const U = 1;
const D = 2;
const L = 4;
const R = 8;
const GLYPHS: Record<number, string> = {
  [U]: "│",
  [D]: "│",
  [L]: "─",
  [R]: "─",
  [U | D]: "│",
  [U | L]: "┘",
  [U | R]: "└",
  [D | L]: "┐",
  [D | R]: "┌",
  [L | R]: "─",
  [U | D | L]: "┤",
  [U | D | R]: "├",
  [U | L | R]: "┴",
  [D | L | R]: "┬",
  [U | D | L | R]: "┼",
};

/** Column x origins. */
const LEFT_X = 0;
const CENTER_X = BOX_W + GUTTER_W;
const RIGHT_X = 2 * (BOX_W + GUTTER_W);
/** Lane columns: lane 1 hugs the neighbor boxes, lane 2 is one char further from them. */
const LEFT_LANE1 = LEFT_X + BOX_W;
const LEFT_LANE2 = LEFT_LANE1 + 1;
const LEFT_ARROW = LEFT_LANE1 + GUTTER_W - 1; // adjacent to the center's left border
const RIGHT_LANE1 = RIGHT_X - 1;
const RIGHT_LANE2 = RIGHT_LANE1 - 1;
const RIGHT_ARROW = CENTER_X + BOX_W; // adjacent to the center's right border

interface Stroke {
  row: number;
  col: number;
  arms: number;
}

const stroke = (row: number, col: number, arms: number): Stroke => ({ row, col, arms });

const isVerticalOnly = (arms: number): boolean => (arms & (U | D)) !== 0 && (arms & (L | R)) === 0;

/** Height of a side column of n boxes (n - 1 blanks between them). */
function columnHeight(n: number): number {
  return n === 0 ? 0 : n * (BOX_H + 1) - 1;
}

/** All strokes of one edge path on `side`, routed through `lane`. */
function edgePath(anchor: number, mid: number, lane: 1 | 2, side: "left" | "right"): Stroke[] {
  const horiz = L | R;
  if (side === "left") {
    if (anchor === mid) {
      return [stroke(mid, LEFT_LANE1, horiz), stroke(mid, LEFT_LANE1 + 1, horiz), stroke(mid, LEFT_ARROW - 1, horiz)];
    }
    const col = lane === 1 ? LEFT_LANE1 : LEFT_LANE2;
    const down = anchor < mid;
    const path: Stroke[] = [];
    if (lane === 2) path.push(stroke(anchor, LEFT_LANE1, horiz)); // entry across lane 1
    path.push(stroke(anchor, col, down ? L | D : L | U));
    for (let row = Math.min(anchor, mid) + 1; row < Math.max(anchor, mid); row++) path.push(stroke(row, col, U | D));
    path.push(stroke(mid, col, down ? U | R : D | R));
    if (col + 1 <= LEFT_ARROW - 1) path.push(stroke(mid, col + 1, horiz));
    if (col + 2 <= LEFT_ARROW - 1) path.push(stroke(mid, col + 2, horiz));
    return path;
  }
  if (anchor === mid) {
    return [stroke(mid, RIGHT_LANE1, horiz), stroke(mid, RIGHT_LANE1 - 1, horiz), stroke(mid, RIGHT_ARROW + 1, horiz)];
  }
  const col = lane === 1 ? RIGHT_LANE1 : RIGHT_LANE2;
  const down = anchor < mid;
  const path: Stroke[] = [];
  if (lane === 2) path.push(stroke(anchor, RIGHT_LANE1, horiz)); // entry across lane 1
  path.push(stroke(anchor, col, down ? R | D : R | U));
  for (let row = Math.min(anchor, mid) + 1; row < Math.max(anchor, mid); row++) path.push(stroke(row, col, U | D));
  path.push(stroke(mid, col, down ? U | L : D | L));
  if (col - 1 >= RIGHT_ARROW + 1) path.push(stroke(mid, col - 1, horiz));
  if (col - 2 >= RIGHT_ARROW + 1) path.push(stroke(mid, col - 2, horiz));
  return path;
}

interface Cell {
  text: string;
  fg?: string;
  bg?: string;
  ref?: string;
  /** internal merge group — borders and interiors of a box NEVER fuse, so segment
   *  structure stays identical whether or not the interior carries a bg. */
  group?: number;
}

/** Truncate with the "…" convention or pad to exactly `width` (E3: we clip ourselves). */
function fit(textValue: string, width: number): string {
  return textValue.length > width ? textValue.slice(0, width - 1) + "…" : textValue.padEnd(width);
}

function paintBox(cells: (Cell | undefined)[][], box: EgoBox, top: number, left: number, selected: boolean, id: number): void {
  const borderGroup = id * 2;
  const interiorGroup = id * 2 + 1;
  const border = (textValue: string): Cell => ({ text: textValue, ref: box.ref, group: borderGroup });
  // D4: risk/selection shading rides the INTERIOR only, never border characters.
  // Selection keeps the gray bg but ADDS fg "black" on label/detail runs (sibling-view
  // pattern, tui/index.tsx row views): medium's risk bg is ALSO gray, so bg alone
  // cannot distinguish a selected box — black-on-gray can, on every bucket. The risk
  // marker keeps its red fg either way (signal, not chrome).
  const bg = selected ? "gray" : RISK_SHADING[box.bucket].bg;
  const selectedFg = selected ? "black" : undefined;
  const interior = (textValue: string): Cell => ({
    text: textValue,
    ...(selectedFg !== undefined ? { fg: selectedFg } : {}),
    ...(bg !== undefined ? { bg } : {}),
    ref: box.ref,
    group: interiorGroup,
  });

  const labelLine = fit(box.marker + box.label, BOX_W - 2);
  const markerRun = box.marker === "" ? "" : labelLine.slice(0, box.marker.length);
  const labelRun = labelLine.slice(markerRun.length);

  const row = top;
  cells[row][left] = border("┌");
  for (let i = 1; i < BOX_W - 1; i++) cells[row][left + i] = border("─");
  cells[row][left + BOX_W - 1] = border("┐");

  cells[row + 1][left] = border("│");
  let x = left + 1;
  for (const char of markerRun) cells[row + 1][x++] = { text: char, fg: "red", ...(bg !== undefined ? { bg } : {}), ref: box.ref, group: interiorGroup };
  for (const char of labelRun) cells[row + 1][x++] = interior(char);
  cells[row + 1][left + BOX_W - 1] = border("│");

  cells[row + 2][left] = border("│");
  x = left + 1;
  for (const char of fit(box.detail, BOX_W - 2)) cells[row + 2][x++] = interior(char);
  cells[row + 2][left + BOX_W - 1] = border("│");

  cells[row + 3][left] = border("└");
  for (let i = 1; i < BOX_W - 1; i++) cells[row + 3][left + i] = border("─");
  cells[row + 3][left + BOX_W - 1] = border("┘");
}

/** Route every neighbor edge of one side; returns the count of dropped edges. */
function routeSide(neighbors: EgoBox[], mid: number, side: "left" | "right"): { grid: Map<number, number>; undrawn: number } {
  const grid = new Map<number, number>();
  const width = egoMinWidth();
  let undrawn = 0;
  for (let i = 0; i < neighbors.length; i++) {
    const anchor = i * (BOX_H + 1) + 2; // border mid-row = boxTop + 2 (the detail row)
    let placed = false;
    for (const lane of [1, 2] as const) {
      const path = edgePath(anchor, mid, lane, side);
      const blocked = path.some((s) => {
        const existing = grid.get(s.row * width + s.col);
        return existing !== undefined && isVerticalOnly(existing) && isVerticalOnly(s.arms);
      });
      if (blocked) continue; // loser spills to lane 2; both blocked ⇒ dropped below
      for (const s of path) grid.set(s.row * width + s.col, (grid.get(s.row * width + s.col) ?? 0) | s.arms);
      placed = true;
      break;
    }
    if (!placed) undrawn++; // dropped edges contribute NO strokes — no strays
  }
  return { grid, undrawn };
}

/** Merge adjacent same-style cells into width-pinned segments (E7 row composition).
 *  Cells fuse only within the same internal group, so a box's border characters and
 *  its interior never merge — segment structure is invariant under selection. */
function toSegments(cells: (Cell | undefined)[]): EgoSegment[] {
  const segments: EgoSegment[] = [];
  const groups: number[] = []; // parallel to segments — the group of the run being accumulated
  for (const cell of cells) {
    const c: Cell = cell ?? { text: " " };
    const group = c.group ?? 0;
    const at = segments.length - 1;
    if (at >= 0 && groups[at] === group && segments[at].fg === c.fg && segments[at].bg === c.bg && segments[at].ref === c.ref) {
      segments[at].text += c.text;
    } else {
      segments.push({ text: c.text, ...(c.fg !== undefined ? { fg: c.fg } : {}), ...(c.bg !== undefined ? { bg: c.bg } : {}), ...(c.ref !== undefined ? { ref: c.ref } : {}) });
      groups.push(group);
    }
  }
  return segments;
}

export function egoLayout(input: EgoLayoutInput): EgoCanvas {
  const width = egoMinWidth();
  const tallest = Math.max(columnHeight(input.callers.length), columnHeight(input.callees.length));
  const centerY = Math.min(Math.floor(tallest / 2), Math.max(0, tallest - BOX_H));
  const mid = centerY + 2; // the center box's border mid-row
  const height = Math.max(tallest, centerY + BOX_H);

  const left = routeSide(input.callers, mid, "left");
  const right = routeSide(input.callees, mid, "right");
  const undrawnEdges = left.undrawn + right.undrawn;

  const cells: (Cell | undefined)[][] = Array.from({ length: height }, () => Array<Cell | undefined>(width).fill(undefined));

  let boxId = 0;
  input.callers.forEach((b, i) => paintBox(cells, b, i * (BOX_H + 1), LEFT_X, b.ref === input.selectedRef, boxId++));
  input.callees.forEach((b, i) => paintBox(cells, b, i * (BOX_H + 1), RIGHT_X, b.ref === input.selectedRef, boxId++));
  paintBox(cells, input.center, centerY, CENTER_X, input.center.ref === input.selectedRef, boxId++);

  for (const [key, arms] of left.grid) cells[Math.floor(key / width)][key % width] = { text: GLYPHS[arms] ?? "·", fg: "gray" };
  for (const [key, arms] of right.grid) cells[Math.floor(key / width)][key % width] = { text: GLYPHS[arms] ?? "·", fg: "gray" };
  // Arrow terminals are painted outside the stroke grids — no edge can overwrite them (E1).
  cells[mid][LEFT_ARROW] = { text: "▶", fg: "gray" };
  cells[mid][RIGHT_ARROW] = { text: "◀", fg: "gray" };

  return { rows: cells.map(toSegments), width, height, undrawnEdges };
}
