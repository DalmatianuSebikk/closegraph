/**
 * IDE screen theme: exact hex palette, deterministic category colors, and the
 * glyph sets used to draw cards and edges in the pixel-accurate codegraph view.
 * Pure TypeScript — no OpenTUI imports; the layout engine and screen model
 * consume these values and translate them into renderables themselves.
 */

export interface IdeTheme {
  readonly background: string;
  readonly panel: string;
  readonly panelElevated: string;
  readonly border: string;
  readonly borderSubtle: string;
  readonly text: string;
  readonly textMuted: string;
  readonly cyan: string;
  readonly purple: string;
  readonly coral: string;
  readonly green: string;
  readonly amber: string;
  readonly selectedBackground: string;
  readonly selectedBorder: string;
  readonly riskLow: string;
  readonly riskMedium: string;
  readonly riskHigh: string;
  readonly edgeCaller: string;
  readonly edgeCallee: string;
  readonly edgeCollapsed: string;
}

export const IDE_THEME: IdeTheme = {
  background: "#0B1220",
  panel: "#111A2B",
  panelElevated: "#172238",
  border: "#52647B",
  borderSubtle: "#344359",
  text: "#E6EDF7",
  textMuted: "#8B9BB1",
  cyan: "#72C7FF",
  purple: "#B59AFF",
  coral: "#FF8D9B",
  green: "#65D6A0",
  amber: "#F1C66D",
  selectedBackground: "#302530",
  selectedBorder: "#FF9CA8",
  riskLow: "#65D6A0", // green
  riskMedium: "#F1C66D", // amber
  riskHigh: "#FF8D9B", // coral
  edgeCaller: "#8B9BB1", // textMuted
  edgeCallee: "#72C7FF", // cyan
  edgeCollapsed: "#8B9BB1", // textMuted
};

/** Category accent rotation, in spec order: purple, coral, green, cyan, amber. */
export const CATEGORY_ORDER: readonly string[] = [
  IDE_THEME.purple,
  IDE_THEME.coral,
  IDE_THEME.green,
  IDE_THEME.cyan,
  IDE_THEME.amber,
];

/** First path segment of a repo-relative file; "(root)" when there is no separator. */
export function categoryOf(file: string): string {
  const slash = file.indexOf("/");
  return slash === -1 ? "(root)" : file.slice(0, slash);
}

/**
 * Pure, stateless category color: the same category string always maps to the
 * same CATEGORY_ORDER entry, regardless of which other categories were queried
 * before it. Index = sum of UTF-16 code units, modulo the palette length.
 */
export function categoryColor(category: string): string {
  let sum = 0;
  for (let i = 0; i < category.length; i++) sum += category.charCodeAt(i);
  return CATEGORY_ORDER[sum % CATEGORY_ORDER.length] as string;
}

/** Node-kind accent colors (kind-colored cards): every Function/Class/File card
 *  border and ◆ dot uses its kind color; the directory-category color stays on
 *  the [CAT] text label. Deterministic — a kind always maps to one color. */
export type NodeKind = "Function" | "Class" | "File";

export function kindColor(kind: NodeKind | undefined): string {
  if (kind === "Class") return IDE_THEME.purple;
  if (kind === "File") return IDE_THEME.green;
  return IDE_THEME.cyan; // Function (and undefined — placeholders' fallback)
}

export function riskColor(bucket: "low" | "medium" | "high"): string {
  if (bucket === "high") return IDE_THEME.riskHigh;
  if (bucket === "medium") return IDE_THEME.riskMedium;
  return IDE_THEME.riskLow;
}

export interface GlyphSet {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
  readonly arrowR: string;
  readonly dash: string;
  readonly dot: string;
  readonly ellipsis: string;
}

export const UNICODE_GLYPHS: GlyphSet = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
  arrowR: "→",
  dash: "┄",
  dot: "◆",
  ellipsis: "…",
};

export const ASCII_GLYPHS: GlyphSet = {
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  h: "-",
  v: "|",
  arrowR: ">",
  dash: "-",
  dot: "*",
  ellipsis: "...",
};
