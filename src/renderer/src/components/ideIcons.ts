/**
 * Brand-icon metadata for the toolbar IDE picker.
 *
 * Each entry is either:
 *   - `path`: an SVG path (viewBox 0 0 24 24) of the IDE's official mark.
 *     The PaneToolbar renders it as a single-colour glyph filled with `color`.
 *   - or `letter`: a fallback initial drawn on top of a `color` chip when we
 *     don't ship a vector for that IDE (Trae, Windsurf, Fleet…).
 *
 * SVG paths are simplified single-fill traces (no gradients) so they tint via
 * `fill` and stay crisp at 14–18px. The IDs match the values returned by
 * src/main/ide.ts → detectIdes().
 */
export interface IdeIcon {
  /** Brand colour. Used as background for the letter chip and as `fill` for the SVG path. */
  color: string
  /** Single-path SVG (viewBox 0 0 24 24). Drawn with `fill: color`. */
  path?: string
  /** First letter shown on a coloured chip when `path` isn't provided. */
  letter?: string
}

// Visual Studio Code — official blue ribbon mark (single-path simplification).
const VSCODE_PATH =
  'M23.15 2.59L18.21.21a1.49 1.49 0 0 0-1.71.29l-9.46 8.63-4.12-3.13a1 1 0 0 0-1.27.06L.33 7.26a1 1 0 0 0 0 1.48L3.9 12 .33 15.26a1 1 0 0 0 0 1.48l1.32 1.2a1 1 0 0 0 1.27.06l4.12-3.13 9.46 8.63a1.49 1.49 0 0 0 1.71.29l4.94-2.38A1.5 1.5 0 0 0 24 20.06V3.94a1.5 1.5 0 0 0-.85-1.35zM18 17.45L10.83 12 18 6.55v10.9z'

// JetBrains square — used as the base for every JetBrains IDE so each gets its
// own brand colour (red for IDEA/Rider, cyan for WebStorm, …) on the same
// recognisable rounded-square silhouette.
const JETBRAINS_SQUARE =
  'M2.4 2.4h19.2v19.2H2.4zM7 17.5l5.4 1.6.8-2.6-3.4-1L11 11l-3.3-.8L7 17.5zm.6-12.2h4v1h-1.5v4h-1V6.3H7.6v-1z'

// Cursor — minimal angled C (custom geometric trace; no public single-path
// official mark, so we use a stylised letter inside a square outline).
const CURSOR_PATH = 'M3 3l18 9-7.5 1.5L12 21 3 3z'

// Sublime Text — overlapping triangle pair simplified to a single S-shape.
const SUBLIME_PATH = 'M20.4 3.6L4 9.1v3.2l16.4-5.5V3.6zM3.6 11.5v3.2L20 20.4v-3.3L3.6 11.5z'

// Zed — angled Z inside a square.
const ZED_PATH = 'M3 3h18v3L9 18h12v3H3v-3L15 6H3V3z'

// OS file manager — generic folder silhouette (tab + body).
const OS_FOLDER_PATH =
  'M3 6.5C3 5.67 3.67 5 4.5 5h4.379a1.5 1.5 0 0 1 1.06.44L11.5 6.5h8a1.5 1.5 0 0 1 1.5 1.5v9.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11z'

/**
 * id → icon registry. IDs match src/main/ide.ts CANDIDATES.
 *
 * For JetBrains products we reuse the same square silhouette path but tint it
 * each product's brand red/cyan/green/etc. This keeps the bundle small and
 * the row visually consistent — the colour alone makes them distinguishable.
 */
export const IDE_ICONS: Record<string, IdeIcon> = {
  vscode: { color: '#007ACC', path: VSCODE_PATH },
  'vscode-insiders': { color: '#24BFA5', path: VSCODE_PATH },
  cursor: { color: '#000000', path: CURSOR_PATH },
  trae: { color: '#000000', letter: 'T' },
  windsurf: { color: '#0EA5E9', letter: 'W' },
  idea: { color: '#FE2857', path: JETBRAINS_SQUARE },
  webstorm: { color: '#22D3EE', path: JETBRAINS_SQUARE },
  pycharm: { color: '#21D789', path: JETBRAINS_SQUARE },
  goland: { color: '#0EB7E9', path: JETBRAINS_SQUARE },
  clion: { color: '#9C2EFF', path: JETBRAINS_SQUARE },
  rider: { color: '#FE2857', path: JETBRAINS_SQUARE },
  phpstorm: { color: '#B345F1', path: JETBRAINS_SQUARE },
  rubymine: { color: '#FC801D', path: JETBRAINS_SQUARE },
  datagrip: { color: '#22D3A6', path: JETBRAINS_SQUARE },
  fleet: { color: '#000000', letter: 'F' },
  subl: { color: '#FF9800', path: SUBLIME_PATH },
  zed: { color: '#5C5CDE', path: ZED_PATH },
  // Tinted slate so it reads as "system" rather than competing with a real
  // editor's brand colour. Matches main/ide.ts's osFolderEntry() id.
  'os-folder': { color: '#64748B', path: OS_FOLDER_PATH }
}

/**
 * Resolve an icon descriptor for an IDE id, with a safe fallback (slate-grey
 * chip showing the first letter of the supplied name) so the renderer never
 * has to branch on `undefined`.
 */
export function iconFor(id: string, name?: string): IdeIcon {
  const hit = IDE_ICONS[id]
  if (hit) return hit
  return { color: '#64748B', letter: (name || id).charAt(0).toUpperCase() || '?' }
}
