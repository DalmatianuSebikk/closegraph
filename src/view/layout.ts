/**
 * Deterministic layouts for the TUI graph views (plan 3 Ruling 1): no force-directed
 * physics — same input + dims always produce the same coordinates, so everything is
 * headless-testable and stable across manual refreshes.
 *
 * Coordinates are grid cells in an abstract canvas: x = column, y = row (0-based, y grows
 * downward). The render layer (Task 4/5) maps them onto flex/scrolled boxes; bounds are
 * advisory (a block taller than the viewport keeps its coordinates — the view-model windows
 * over them), which is what keeps appends from ever moving existing positions.
 */

/** Cell width of one file entry (matches the label width the file map renders). */
const FILE_CELL_W = 12;

/** Columns available at the given width. */
function columnsOf(width: number): number {
  return Math.max(1, Math.floor(width / FILE_CELL_W));
}

export interface Point {
  x: number;
  y: number;
}

export interface FileEntry {
  readonly ref: string;
  readonly dir: string;
}

/**
 * Directory-grouped grid, column-flow: files are grouped by directory, sorted by ref inside
 * each directory block; every block gets its own column (a directory never shares a column),
 * columns advance left-to-right up to the width, and further blocks wrap onto a fresh
 * full-height band below. Each block reserves one leading row for the directory header (files
 * start at blockY + 1). Appending a file (a ref sorting after the directory's current last
 * ref) only extends that block downward — every existing position stays put. A block taller
 * than the viewport keeps its coordinates (it overflows its band); the view-model windows
 * over the canvas instead of re-flowing.
 *
 * COLLISION POLICY (binding on consumers): because bands advance by a fixed height while
 * blocks are not height-capped, a directory with more files than the band height overflows
 * into the next band's rows in the same column — two files can share an identical (x, y).
 * Task 4's render model MUST render nodes in stable layout order (this Map's insertion
 * order: directories sorted, files sorted within) and SKIP any node whose (x, y) cell is
 * already occupied — the first stable-order node wins the cell. This keeps hit-testing and
 * windowing deterministic without giving up append-stability.
 */
export function fileMapLayout(
  files: FileEntry[],
  dims: { width: number; height: number },
): Map<string, Point> {
  const byDir = new Map<string, FileEntry[]>();
  for (const f of files) {
    const list = byDir.get(f.dir);
    if (list === undefined) byDir.set(f.dir, [f]);
    else list.push(f);
  }

  const dirs = [...byDir.keys()].sort();
  for (const dir of dirs) byDir.get(dir)!.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const cols = columnsOf(dims.width);
  const rows = Math.max(1, dims.height);

  const out = new Map<string, Point>();
  let x = 0;
  let bandTop = 0;
  for (const dir of dirs) {
    const entries = byDir.get(dir)!;
    if (x >= cols) {
      x = 0;
      bandTop += rows;
    }
    let k = 0;
    for (const f of entries) {
      out.set(f.ref, { x, y: bandTop + 1 + k });
      k += 1;
    }
    x += 1;
  }
  return out;
}

export interface SymbolNode {
  readonly ref: string;
  readonly depthFromSeed: number;
}

/**
 * Layered symbol layout: nodes are grouped by depthFromSeed, layers are stacked top-to-bottom
 * in ascending depth order (callers — negative depths — above the seed layer, callees below),
 * and each layer is left-packed in sorted-ref order. A layer wider than the available columns
 * wraps within its own band, keeping neighbors adjacent.
 */
export function symbolLayout(
  nodes: SymbolNode[],
  dims: { width: number; height: number },
): Map<string, Point> {
  void dims.height; // vertical banding is derived from layer sizes; height reserved for future windowing
  const cols = columnsOf(dims.width);

  const byDepth = new Map<number, SymbolNode[]>();
  for (const n of nodes) {
    const list = byDepth.get(n.depthFromSeed);
    if (list === undefined) byDepth.set(n.depthFromSeed, [n]);
    else list.push(n);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const out = new Map<string, Point>();
  let bandY = 0;
  for (const depth of depths) {
    const layer = byDepth.get(depth)!;
    layer.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    let k = 0;
    for (const n of layer) {
      out.set(n.ref, { x: k % cols, y: bandY + Math.floor(k / cols) });
      k += 1;
    }
    bandY += Math.max(1, Math.ceil(layer.length / cols));
  }
  return out;
}
