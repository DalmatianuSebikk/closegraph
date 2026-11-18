/**
 * IDE cell-buffer canvas (codegraph-ide-screen plan Task 2): PURE fixed-geometry
 * composer — no OpenTUI imports, no clock. Same input ⇒ same canvas byte-for-byte;
 * the screen model (Task 3) owns viewport windowing and the render layer (Task 4)
 * maps rows onto height-1 <text> segments. Mirrors ego-layout's proven approach:
 * (Cell|undefined)[][] composition, 4-bit arm-mask stroke union per gutter, two
 * vertical lanes with stable-order winner, dropped edges counted in undrawnEdges,
 * arrow terminals painted last and never overwritten.
 *
 * Geometry (spec §4, constants pinned by the plan):
 * - Cards are 35×5 (border / name+category / file:line / risk+fans / border) with a
 *   33-char interior: 1 pad column each side; the ◆ name row and the 3-space-indented
 *   metadata rows share a 29-char content block so metadata aligns under the name.
 * - Columns are ordered left→right by the input; column x accumulates
 *   (prev.x + cardW + GUTTER_W). COMPACT mode (Task 3's 68–79-col mode) swaps the
 *   card width per CANVAS — never per column — via the optional `compact` flag.
 * - Cards in a column stack top-down at V_PITCH in input order; the center column
 *   is vertically centered against the tallest side column (ego rule).
 * - Edges always run left→right: ring-1 cards connect to the center card, ring ≥ 2
 *   cards connect to their `parentRef` card in the adjacent inner column. The
 *   arrowhead occupies the destination-adjacent gutter cell, is drawn LAST, and is
 *   never overwritten. Left-of-center gutters use edgeCaller, right edgeCallee;
 *   a placeholder endpoint turns the whole edge dashed + edgeCollapsed.
 *
 * Colors are theme HEX strings on every painted cell (Task 1's palette exists for
 * this); the render layer passes them to OpenTUI which parses hex.
 */
import type { RiskBucket } from "./risk.js";
import { IDE_THEME, UNICODE_GLYPHS, categoryColor, kindColor, riskColor, type GlyphSet } from "./ide-theme.js";

export interface Cell {
  char: string;
  fg: string;
  bg: string;
  bold?: boolean;
  underline?: boolean;
  /** node hit-test target — card cells carry their card's ref, edge cells never do */
  ref?: string;
}

export interface IdeCard {
  ref: string;
  name: string;
  category: string;
  /** node kind — the card's accent color (kindColor); undefined on placeholders */
  kind?: "Function" | "Class" | "File";
  file: string;
  startLine: number; // 0 → "—"
  signature?: string;
  risk: RiskBucket;
  fanIn: number;
  fanOut: number;
  /** set ⇒ dashed collapsed "+N more" card (name = placeholder) */
  placeholder?: string;
  /** ring ≥ 2 cards: ref of the parent card in the adjacent inner column (REQUIRED) */
  parentRef?: string;
}

export interface IdeColumn {
  side: "left" | "center" | "right";
  /** distance from center (center=0; depth1 ⇒ left ring1 + right ring1; depth2 ⇒ ±2) */
  ring: number;
  cards: IdeCard[];
}

export interface IdeLayoutInput {
  /** ordered left→right; exactly one center */
  columns: IdeColumn[];
  selectedRef?: string;
  /** default UNICODE_GLYPHS */
  glyphs?: GlyphSet;
  /** per-CANVAS compact switch (Task 3's 68–79-col mode): all cards COMPACT_CARD_W */
  compact?: boolean;
}

export interface CardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IdeCanvas {
  /** [row][col] — undefined cells render as background spaces */
  cells: (Cell | undefined)[][];
  width: number;
  height: number;
  /** edges that could not be routed (incl. ring ≥ 2 cards with an unknown parentRef) — disclosed, never silently missing */
  undrawnEdges: number;
  /** by ref — viewport scroll-into-view + hit-test + minimap */
  cardRects: Map<string, CardRect>;
}

export interface IdeSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
  ref?: string;
}

export const CARD_W = 35; // spec §4; interior 33, 1-col padding each side
export const CARD_H = 5; // border / name+category / file:line / risk+fans / border
export const CARD_MID_ROW = 2; // edge anchor row within a card
export const GUTTER_W = 6; // spec: min horizontal separation 6
export const V_PITCH = 7; // CARD_H + min vertical separation 2
export const COMPACT_CARD_W = 20;

// --- stroke-union glyph algebra (ego E1: 4-bit arm masks) ---
const U = 1;
const D = 2;
const L = 4;
const R = 8;

const isVerticalOnly = (arms: number): boolean => (arms & (U | D)) !== 0 && (arms & (L | R)) === 0;
const isHorizontalOnly = (arms: number): boolean => (arms & (L | R)) !== 0 && (arms & (U | D)) === 0;

/**
 * Stroke mask → character. UNICODE gets the sharp corners/junctions (┐┘└┌├┤┬┴┼ —
 * the GlyphSet's rounded corners are card chrome, not edge strokes). The ASCII set
 * has no junction glyphs, so every mixed-arm mask collapses to its corner char "+".
 */
function strokeGlyphs(g: GlyphSet): Record<number, string> {
  if (g.h === "-") {
    return {
      [U]: g.v, [D]: g.v, [U | D]: g.v,
      [L]: g.h, [R]: g.h, [L | R]: g.h,
      [U | L]: g.tl, [U | R]: g.tl, [D | L]: g.tl, [D | R]: g.tl,
      [U | D | L]: g.tl, [U | D | R]: g.tl, [U | L | R]: g.tl, [D | L | R]: g.tl, [U | D | L | R]: g.tl,
    };
  }
  return {
    [U]: g.v, [D]: g.v, [U | D]: g.v,
    [L]: g.h, [R]: g.h, [L | R]: g.h,
    [U | L]: "┘", [U | R]: "└", [D | L]: "┐", [D | R]: "┌",
    [U | D | L]: "┤", [U | D | R]: "├", [U | L | R]: "┴", [D | L | R]: "┬", [U | D | L | R]: "┼",
  };
}

/** Truncate with the glyph set's ellipsis or pad to exactly `width` (we clip ourselves). */
function fit(textValue: string, width: number, ellipsis: string): string {
  return textValue.length > width ? textValue.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis : textValue.padEnd(width);
}

/** Height of a column of n cards (n - 1 two-row gaps between them). */
function columnHeight(n: number): number {
  return n === 0 ? 0 : n * V_PITCH - (V_PITCH - CARD_H);
}

interface PositionedCard {
  card: IdeCard;
  x: number;
  y: number;
  /** edge anchor row: y + CARD_MID_ROW */
  mid: number;
}

interface EdgeReq {
  src: PositionedCard;
  dst: PositionedCard;
  /** gutter base color (edgeCaller left of center, edgeCallee right); placeholder overrides */
  fg: string;
}

interface Stroke {
  row: number;
  col: number;
  arms: number;
}

const stroke = (row: number, col: number, arms: number): Stroke => ({ row, col, arms });

/** All strokes of one edge path through `lane` (1 hugs the source card, 2 is one char further). */
function edgePath(srcMid: number, dstMid: number, lane: 1 | 2, lane1: number, lane2: number, arrowCol: number): Stroke[] {
  const horiz = L | R;
  if (srcMid === dstMid) {
    const path: Stroke[] = [];
    for (let col = lane1; col < arrowCol; col++) path.push(stroke(srcMid, col, horiz));
    return path;
  }
  const col = lane === 1 ? lane1 : lane2;
  const down = srcMid < dstMid;
  const path: Stroke[] = [];
  if (lane === 2) path.push(stroke(srcMid, lane1, horiz)); // entry across lane 1
  path.push(stroke(srcMid, col, down ? L | D : L | U));
  for (let row = Math.min(srcMid, dstMid) + 1; row < Math.max(srcMid, dstMid); row++) path.push(stroke(row, col, U | D));
  path.push(stroke(dstMid, col, down ? U | R : D | R));
  for (let c = col + 1; c < arrowCol; c++) path.push(stroke(dstMid, c, horiz));
  return path;
}

interface StrokeCell {
  arms: number;
  dashed: boolean;
  fg: string;
}

interface RoutedGutter {
  grid: Map<number, StrokeCell>;
  arrows: { row: number; col: number; fg: string }[];
  undrawn: number;
}

/**
 * Route every edge of one gutter. Claims are taken in code-unit order of source ref
 * (destination ref breaks ties — same-source fan-out), so the winner is stable; a
 * loser spills to lane 2, and a fully blocked edge is DROPPED with no strokes at all.
 */
function routeGutter(edges: EdgeReq[], gutterX: number, canvasW: number): RoutedGutter {
  const grid = new Map<number, StrokeCell>();
  const arrows: { row: number; col: number; fg: string }[] = [];
  let undrawn = 0;
  const lane1 = gutterX;
  const lane2 = gutterX + 1;
  const arrowCol = gutterX + GUTTER_W - 1;
  const sorted = [...edges].sort((a, b) =>
    a.src.card.ref < b.src.card.ref ? -1 : a.src.card.ref > b.src.card.ref ? 1 : a.dst.card.ref < b.dst.card.ref ? -1 : a.dst.card.ref > b.dst.card.ref ? 1 : 0,
  );
  for (const edge of sorted) {
    const placeholder = edge.src.card.placeholder !== undefined || edge.dst.card.placeholder !== undefined;
    const fg = placeholder ? IDE_THEME.edgeCollapsed : edge.fg;
    const dashed = placeholder;
    let placed = false;
    for (const lane of [1, 2] as const) {
      const path = edgePath(edge.src.mid, edge.dst.mid, lane, lane1, lane2, arrowCol);
      const blocked = path.some((s) => {
        const existing = grid.get(s.row * canvasW + s.col);
        return existing !== undefined && isVerticalOnly(existing.arms) && isVerticalOnly(s.arms);
      });
      if (blocked) continue; // loser spills to lane 2; both blocked ⇒ dropped below
      for (const s of path) {
        const key = s.row * canvasW + s.col;
        const existing = grid.get(key);
        grid.set(key, { arms: (existing?.arms ?? 0) | s.arms, dashed: (existing?.dashed ?? false) || dashed, fg: existing?.fg ?? fg });
      }
      arrows.push({ row: edge.dst.mid, col: arrowCol, fg });
      placed = true;
      break;
    }
    if (!placed) undrawn++; // dropped edges contribute NO strokes and NO arrowhead — no strays
  }
  return { grid, arrows, undrawn };
}

/** Paint one 5-row card at (x, y); interior cells all carry `bg` and the card's ref. */
function paintCard(cells: (Cell | undefined)[][], pc: PositionedCard, w: number, glyphs: GlyphSet, selected: boolean, isCenter: boolean): void {
  const { card, x, y } = pc;
  const placeholder = card.placeholder !== undefined;
  const catColor = categoryColor(card.category);
  const accent = kindColor(card.kind);
  const borderFg = placeholder ? IDE_THEME.edgeCollapsed : selected ? IDE_THEME.selectedBorder : isCenter ? IDE_THEME.cyan : accent;
  const bg = selected ? IDE_THEME.selectedBackground : IDE_THEME.background;
  const border = (char: string): Cell => ({ char, fg: borderFg, bg: IDE_THEME.background, ref: card.ref });
  const put = (row: number, colN: number, cell: Cell): void => {
    cells[row][colN] = cell;
  };

  // rows 0 and 4: ╭─×(w-2)─╮ / ╰─×(w-2)─╯
  put(y, x, border(glyphs.tl));
  put(y + CARD_H - 1, x, border(glyphs.bl));
  for (let i = 1; i < w - 1; i++) {
    put(y, x + i, border(glyphs.h));
    put(y + CARD_H - 1, x + i, border(glyphs.h));
  }
  put(y, x + w - 1, border(glyphs.tr));
  put(y + CARD_H - 1, x + w - 1, border(glyphs.br));

  for (const row of [y + 1, y + 2, y + 3]) {
    put(row, x, border(glyphs.v));
    put(row, x + w - 1, border(glyphs.v));
  }

  if (placeholder) {
    // collapsed "+N more" summary: name row only, everything edgeCollapsed, no ◆
    const line = fit(` ${card.placeholder ?? card.name}`, w - 2, glyphs.ellipsis);
    for (let i = 0; i < w - 2; i++) put(y + 1, x + 1 + i, { char: line[i] ?? " ", fg: IDE_THEME.edgeCollapsed, bg, ref: card.ref });
    for (const row of [y + 2, y + 3]) {
      for (let i = 0; i < w - 2; i++) put(row, x + 1 + i, { char: " ", fg: IDE_THEME.edgeCollapsed, bg, ref: card.ref });
    }
    return;
  }

  // row 1: │ ◆ {name}…{pad}[{CAT}] │ — nameblock (w-6) = name left, [CAT] right
  const catLabel = `[${card.category.slice(0, 8).toUpperCase()}]`;
  const nameFit = fit(card.name, w - 6 - catLabel.length, glyphs.ellipsis);
  put(y + 1, x + 1, { char: " ", fg: IDE_THEME.text, bg, ref: card.ref });
  put(y + 1, x + 2, { char: glyphs.dot, fg: accent, bg, ref: card.ref });
  put(y + 1, x + 3, { char: " ", fg: IDE_THEME.text, bg, ref: card.ref });
  for (let i = 0; i < nameFit.length; i++) put(y + 1, x + 4 + i, { char: nameFit[i] as string, fg: IDE_THEME.text, bg, bold: true, ref: card.ref });
  for (let i = 0; i < catLabel.length; i++) put(y + 1, x + 4 + nameFit.length + i, { char: catLabel[i] as string, fg: catColor, bg, ref: card.ref });
  put(y + 1, x + w - 2, { char: " ", fg: IDE_THEME.text, bg, ref: card.ref });

  // row 2: │   {file}:{line}{pad} │ — 3-space indent aligns metadata under the name
  const fileLine = fit(`${card.file}:${card.startLine === 0 ? "—" : card.startLine}`, w - 6, glyphs.ellipsis);
  for (let i = 0; i < w - 2; i++) put(y + 2, x + 1 + i, { char: " ", fg: IDE_THEME.textMuted, bg, ref: card.ref });
  for (let i = 0; i < fileLine.length; i++) put(y + 2, x + 4 + i, { char: fileLine[i] as string, fg: IDE_THEME.textMuted, bg, ref: card.ref });

  // row 3: │   Risk: {LOW|MED|HIGH}  In: {n}  Out: {n}{pad} │ — risk word in riskColor
  const word = card.risk === "high" ? "HIGH" : card.risk === "medium" ? "MED" : "LOW";
  const riskLine = fit(`Risk: ${word}  In: ${card.fanIn}  Out: ${card.fanOut}`, w - 6, glyphs.ellipsis);
  for (let i = 0; i < w - 2; i++) put(y + 3, x + 1 + i, { char: " ", fg: IDE_THEME.textMuted, bg, ref: card.ref });
  const wordStart = "Risk: ".length;
  for (let i = 0; i < riskLine.length; i++) {
    const inWord = i >= wordStart && i < wordStart + word.length;
    put(y + 3, x + 4 + i, { char: riskLine[i] as string, fg: inWord ? riskColor(card.risk) : IDE_THEME.textMuted, bg, ref: card.ref });
  }
}

export function ideLayout(input: IdeLayoutInput): IdeCanvas {
  const glyphs = input.glyphs ?? UNICODE_GLYPHS;
  const cardW = input.compact === true ? COMPACT_CARD_W : CARD_W;
  const columns = input.columns;
  if (columns.length === 0) return { cells: [], width: 0, height: 0, undrawnEdges: 0, cardRects: new Map() };

  // column x accumulates left→right; compact width applies per-canvas, never per-column
  const colX: number[] = [];
  {
    let x = 0;
    for (let i = 0; i < columns.length; i++) {
      colX.push(x);
      x += cardW + GUTTER_W;
    }
  }
  const width = columns.length * cardW + (columns.length - 1) * GUTTER_W;
  const centerIdx = columns.findIndex((c) => c.ring === 0);

  // center column vertically centered against the tallest side column (ego rule)
  const tallest = Math.max(0, ...columns.map((c, i) => (i === centerIdx ? 0 : columnHeight(c.cards.length))));
  const centerH = centerIdx === -1 ? 0 : columnHeight(columns[centerIdx].cards.length);
  const centerY = Math.min(Math.floor(tallest / 2), Math.max(0, tallest - centerH));
  const height = Math.max(tallest, centerY + centerH);

  const positioned: PositionedCard[][] = columns.map((col, ci) => {
    const y0 = ci === centerIdx ? centerY : 0;
    return col.cards.map((card, i) => ({ card, x: colX[ci] as number, y: y0 + i * V_PITCH, mid: y0 + i * V_PITCH + CARD_MID_ROW }));
  });

  const cardRects = new Map<string, CardRect>();
  for (const list of positioned) for (const pc of list) cardRects.set(pc.card.ref, { x: pc.x, y: pc.y, w: cardW, h: CARD_H });

  // one edge per non-center card toward the center: ring1 → center card; ring ≥ 2 →
  // its parentRef card in the adjacent inner column. Direction is always left→right.
  const byRef = positioned.map((list) => new Map(list.map((pc) => [pc.card.ref, pc])));
  const gutterEdges: EdgeReq[][] = Array.from({ length: Math.max(0, columns.length - 1) }, () => []);
  let undrawnEdges = 0;
  if (centerIdx !== -1) {
    const center = positioned[centerIdx][0];
    for (let ci = 0; ci < columns.length; ci++) {
      if (ci === centerIdx) continue;
      const left = ci < centerIdx;
      const fg = left ? IDE_THEME.edgeCaller : IDE_THEME.edgeCallee;
      for (const pc of positioned[ci]) {
        if (columns[ci].ring === 1) {
          if (center === undefined) continue;
          if (left) (gutterEdges[ci] as EdgeReq[]).push({ src: pc, dst: center, fg });
          else (gutterEdges[ci - 1] as EdgeReq[]).push({ src: center, dst: pc, fg });
        } else {
          const parentIdx = left ? ci + 1 : ci - 1;
          const parent = pc.card.parentRef === undefined ? undefined : byRef[parentIdx]?.get(pc.card.parentRef);
          if (parent === undefined) {
            undrawnEdges++; // unroutable without a parent — disclosed, never silently missing
            continue;
          }
          if (left) (gutterEdges[ci] as EdgeReq[]).push({ src: pc, dst: parent, fg });
          else (gutterEdges[ci - 1] as EdgeReq[]).push({ src: parent, dst: pc, fg });
        }
      }
    }
  }

  const strokes = strokeGlyphs(glyphs);
  const cells: (Cell | undefined)[][] = Array.from({ length: height }, () => Array<Cell | undefined>(width).fill(undefined));

  // edges BEFORE cards (gutters are card-free, so cards never overwrite edge cells)
  const arrows: { row: number; col: number; fg: string }[] = [];
  for (let g = 0; g < gutterEdges.length; g++) {
    const routed = routeGutter(gutterEdges[g] as EdgeReq[], (colX[g] as number) + cardW, width);
    undrawnEdges += routed.undrawn;
    arrows.push(...routed.arrows);
    for (const [key, cell] of routed.grid) {
      const row = Math.floor(key / width);
      const colN = key % width;
      const char = cell.dashed && isHorizontalOnly(cell.arms) ? glyphs.dash : (strokes[cell.arms] ?? "·");
      cells[row][colN] = { char, fg: cell.fg, bg: IDE_THEME.background };
    }
  }

  for (let ci = 0; ci < columns.length; ci++) {
    for (const pc of positioned[ci]) paintCard(cells, pc, cardW, glyphs, pc.card.ref === input.selectedRef, ci === centerIdx);
  }

  // arrowheads LAST and never overwritten: no stroke path includes their cells
  for (const arrow of arrows) {
    cells[arrow.row][arrow.col] = { char: glyphs.arrowR, fg: arrow.fg, bg: IDE_THEME.background };
  }

  return { cells, width, height, undrawnEdges, cardRects };
}

/**
 * Merge adjacent same-style cells into width-pinned segments; every row's segments
 * concatenate to exactly `width`. Undefined cells become spaces with default fg/bg
 * OMITTED (the render layer leaves the route background alone).
 */
export function toSegments(cells: (Cell | undefined)[][], width: number): IdeSegment[][] {
  return cells.map((row) => {
    const segments: IdeSegment[] = [];
    for (let c = 0; c < width; c++) {
      const cell = row[c];
      const char = cell?.char ?? " ";
      const at = segments.length - 1;
      const last = at >= 0 ? segments[at] : undefined;
      if (
        last !== undefined &&
        last.fg === cell?.fg &&
        last.bg === cell?.bg &&
        last.bold === cell?.bold &&
        last.underline === cell?.underline &&
        last.ref === cell?.ref
      ) {
        last.text += char;
      } else {
        segments.push({
          text: char,
          ...(cell?.fg !== undefined ? { fg: cell.fg } : {}),
          ...(cell?.bg !== undefined ? { bg: cell.bg } : {}),
          ...(cell?.bold !== undefined ? { bold: cell.bold } : {}),
          ...(cell?.underline !== undefined ? { underline: cell.underline } : {}),
          ...(cell?.ref !== undefined ? { ref: cell.ref } : {}),
        });
      }
    }
    return segments;
  });
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Minimap projection: every card rect becomes one "█" cell (its center, projected)
 * colored by categoryColorOf(ref); the viewport rect is drawn as a bright outline
 * over whatever it covers. Degenerate inputs yield an empty (all-undefined) map.
 */
export function minimapCells(
  rects: Iterable<CardRect & { ref?: string }>,
  canvasW: number,
  canvasH: number,
  mapW: number,
  mapH: number,
  viewport: CardRect | undefined,
  categoryColorOf: (ref: string) => string | undefined,
): (Cell | undefined)[][] {
  const grid: (Cell | undefined)[][] = Array.from({ length: Math.max(0, mapH) }, () => Array<Cell | undefined>(Math.max(0, mapW)).fill(undefined));
  if (mapW <= 0 || mapH <= 0 || canvasW <= 0 || canvasH <= 0) return grid;
  for (const rect of rects) {
    const colN = clamp(Math.floor(((rect.x + rect.w / 2) / canvasW) * mapW), 0, mapW - 1);
    const row = clamp(Math.floor(((rect.y + rect.h / 2) / canvasH) * mapH), 0, mapH - 1);
    const color = rect.ref === undefined ? undefined : categoryColorOf(rect.ref);
    grid[row][colN] = {
      char: "█",
      fg: color ?? IDE_THEME.textMuted,
      bg: IDE_THEME.background,
      ...(rect.ref !== undefined ? { ref: rect.ref } : {}),
    };
  }
  if (viewport !== undefined) {
    const left = clamp(Math.floor((viewport.x / canvasW) * mapW), 0, mapW - 1);
    const right = clamp(Math.floor(((viewport.x + Math.max(0, viewport.w - 1)) / canvasW) * mapW), 0, mapW - 1);
    const top = clamp(Math.floor((viewport.y / canvasH) * mapH), 0, mapH - 1);
    const bottom = clamp(Math.floor(((viewport.y + Math.max(0, viewport.h - 1)) / canvasH) * mapH), 0, mapH - 1);
    const put = (row: number, colN: number): void => {
      grid[row][colN] = { char: "█", fg: IDE_THEME.text, bg: IDE_THEME.background };
    };
    for (let c = left; c <= right; c++) {
      put(top, c);
      if (bottom !== top) put(bottom, c);
    }
    for (let r = top; r <= bottom; r++) {
      put(r, left);
      if (right !== left) put(r, right);
    }
  }
  return grid;
}
