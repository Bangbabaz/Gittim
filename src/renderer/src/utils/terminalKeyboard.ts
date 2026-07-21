export type TerminalKeyAction =
  | { kind: 'write'; data: string }
  | { kind: 'native-input'; fallbackId?: number }

export interface TerminalTextInputAction {
  data: string | null
}

interface PendingNativeInput {
  id: number
  fallback: string
  dataSeen: boolean
}

const NATIVE_PUNCTUATION_CODES = new Set([
  'Backquote',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'IntlRo',
  'IntlYen'
])

/**
 * Routes Windows IME punctuation through Chromium's native text input path.
 * Some third-party IMEs submit punctuation with a normal keyCode instead of
 * 229. Letting xterm handle that keydown would emit the ASCII key and cancel
 * the IME's later input event.
 */
export class TerminalInputHandler {
  private composing = false
  private nextDoubleQuoteIsOpening = true
  private nextSingleQuoteIsOpening = true
  private nextNativeInputId = 1
  private pendingNativeInputs: PendingNativeInput[] = []

  constructor(private readonly platform: string) {}

  handleKeyEvent(e: KeyboardEvent): TerminalKeyAction | null {
    if (e.type === 'keypress') {
      return this.shouldUseNativeTextInput(e) ? { kind: 'native-input' } : null
    }
    if (e.type !== 'keydown') return null

    const modifiedEnter =
      e.code === 'Enter' &&
      !e.ctrlKey &&
      !e.metaKey &&
      ((e.shiftKey && !e.altKey) || (e.altKey && !e.shiftKey))

    if (modifiedEnter && !this.composing && !e.isComposing && e.keyCode !== 229) {
      return {
        kind: 'write',
        data: this.platform === 'win32' ? '\x1b[13;28;13;1;16;1_' : '\n'
      }
    }

    if (this.shouldWriteEscape(e)) return { kind: 'write', data: '\x1b' }
    if (!this.shouldUseNativeTextInput(e)) return null

    const pending: PendingNativeInput = {
      id: this.nextNativeInputId++,
      fallback: e.key,
      dataSeen: false
    }
    this.pendingNativeInputs.push(pending)
    return { kind: 'native-input', fallbackId: pending.id }
  }

  handleBeforeInput(e: InputEvent): TerminalTextInputAction | null {
    if (
      this.composing ||
      this.pendingNativeInputs.length === 0 ||
      !e.cancelable ||
      !e.inputType.startsWith('insert') ||
      (e.data !== '“”' && e.data !== '‘’')
    ) {
      return null
    }

    const pending = this.pendingNativeInputs.shift()!
    return { data: pending.dataSeen ? null : this.normalizeNativeText(e.data) }
  }

  handleInput(e: InputEvent): TerminalTextInputAction | null {
    if (
      this.composing ||
      this.pendingNativeInputs.length === 0 ||
      !e.inputType.startsWith('insert') ||
      typeof e.data !== 'string' ||
      e.data.length === 0
    ) {
      return null
    }

    const pending = this.pendingNativeInputs.shift()!
    return { data: pending.dataSeen ? null : this.normalizeNativeText(e.data) }
  }

  observeData(data: string): void {
    if (!data) return
    this.syncQuotePairing(data)
    if (this.pendingNativeInputs.length === 0) return
    this.pendingNativeInputs[0].dataSeen = true
  }

  compositionStart(): void {
    this.composing = true
    this.pendingNativeInputs = []
  }

  compositionEnd(): void {
    this.composing = false
  }

  takeNativeInputFallback(id: number): string | null {
    const index = this.pendingNativeInputs.findIndex((pending) => pending.id === id)
    if (index === -1) return null

    const [pending] = this.pendingNativeInputs.splice(index, 1)
    return pending.dataSeen ? null : pending.fallback
  }

  reset(): void {
    this.composing = false
    this.pendingNativeInputs = []
  }

  private shouldUseNativeTextInput(e: KeyboardEvent): boolean {
    if (
      this.platform !== 'win32' ||
      this.composing ||
      e.isComposing ||
      e.keyCode === 229 ||
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      Array.from(e.key).length !== 1
    ) {
      return false
    }

    return /^Digit[0-9]$/.test(e.code) || NATIVE_PUNCTUATION_CODES.has(e.code)
  }

  private normalizeNativeText(data: string): string {
    if (data === '“”') {
      const quote = this.nextDoubleQuoteIsOpening ? '“' : '”'
      this.nextDoubleQuoteIsOpening = !this.nextDoubleQuoteIsOpening
      return quote
    }
    if (data === '‘’') {
      const quote = this.nextSingleQuoteIsOpening ? '‘' : '’'
      this.nextSingleQuoteIsOpening = !this.nextSingleQuoteIsOpening
      return quote
    }

    this.syncQuotePairing(data)
    return data
  }

  private syncQuotePairing(data: string): void {
    for (const char of data) {
      if (char === '“') this.nextDoubleQuoteIsOpening = false
      else if (char === '”') this.nextDoubleQuoteIsOpening = true
      else if (char === '‘') this.nextSingleQuoteIsOpening = false
      else if (char === '’') this.nextSingleQuoteIsOpening = true
    }
  }

  private shouldWriteEscape(e: KeyboardEvent): boolean {
    return (
      this.platform === 'win32' &&
      !this.composing &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      (e.code === 'Escape' || e.key === 'Escape' || e.keyCode === 27)
    )
  }
}
