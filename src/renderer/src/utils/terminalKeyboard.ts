/**
 * Return input that needs to bypass xterm's keyboard translation.
 *
 * Windows Chromium can report the Quote key in a form that xterm does not
 * turn into terminal data. Forward only completed, printable quote
 * characters; dead keys and IME composition must continue through xterm.
 *
 * Modified Enter is encoded as ESC+CR on Windows. This is the sequence used
 * by terminal applications (including Codex) to distinguish it from the CR
 * produced by plain Enter. A bare LF is not consistently preserved by
 * ConPTY/TUI input handling.
 */
export function terminalKeyboardInput(e: KeyboardEvent, platform: string): string | null {
  if (e.type !== 'keydown') return null

  const modifiedEnter =
    e.code === 'Enter' &&
    !e.ctrlKey &&
    !e.metaKey &&
    ((e.shiftKey && !e.altKey) || (e.altKey && !e.shiftKey))

  if (modifiedEnter) return platform === 'win32' ? '\x1b\r' : '\n'

  if (
    platform === 'win32' &&
    e.code === 'Quote' &&
    (e.key === "'" || e.key === '"') &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing &&
    e.keyCode !== 229
  ) {
    return e.key
  }

  return null
}
