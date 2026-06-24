import type { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * Prefer the hardware-accelerated renderer, but keep xterm's DOM renderer as
 * a transparent fallback for unsupported GPUs, exhausted WebGL contexts and
 * context loss. Disposing WebglAddon restores the built-in DOM renderer.
 */
export function enableWebglRenderer(terminal: Terminal): void {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => addon.dispose())
    terminal.loadAddon(addon)
  } catch {
    // WebGL2 unavailable or renderer creation failed; DOM rendering remains active.
  }
}

/**
 * Web fonts can become ready after the terminal's first fit. Re-measure once
 * they settle so cell dimensions, PTY columns and glyph positions agree.
 */
export async function waitForTerminalFonts(): Promise<void> {
  try {
    await document.fonts?.ready
  } catch {
    // Font loading failures should not block terminal startup.
  }
}
