const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const sourcePath = path.join(
  __dirname,
  '..',
  'src',
  'renderer',
  'src',
  'utils',
  'terminalKeyboard.ts'
)
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const loaded = { exports: {} }
new Function('exports', 'module', compiled)(loaded.exports, loaded)
const { TerminalInputHandler } = loaded.exports

function key(overrides = {}) {
  return {
    type: 'keydown',
    code: '',
    key: '',
    keyCode: 0,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides
  }
}

function inputEvent(data, inputType = 'insertText') {
  return { data, inputType, cancelable: true }
}

function beginNativeInput(input, event) {
  const action = input.handleKeyEvent(key(event))
  assert.equal(action.kind, 'native-input')
  assert.equal(typeof action.fallbackId, 'number')
  return action.fallbackId
}

// English punctuation uses the native input event and never reaches fallback.
{
  const input = new TerminalInputHandler('win32')
  const quote = { code: 'Quote', key: "'", keyCode: 222 }
  const fallbackId = beginNativeInput(input, quote)
  assert.deepEqual(input.handleKeyEvent(key({ type: 'keypress', ...quote })), {
    kind: 'native-input'
  })
  assert.deepEqual(input.handleInput(inputEvent("'")), { data: "'" })
  assert.equal(input.takeNativeInputFallback(fallbackId), null)
}

// If xterm emitted the input first, the DOM input handler only clears the
// textarea and must not forward the same character a second time.
{
  const input = new TerminalInputHandler('win32')
  const fallbackId = beginNativeInput(input, { code: 'Quote', key: '"', shiftKey: true })
  input.observeData('"')
  assert.deepEqual(input.handleInput(inputEvent('"')), { data: null })
  assert.equal(input.takeNativeInputFallback(fallbackId), null)
}

// Forward the exact character committed by the IME. Quote pairing belongs to
// the input method when it submits one character at a time.
{
  const input = new TerminalInputHandler('win32')
  const firstId = beginNativeInput(input, { code: 'Quote', key: '"', shiftKey: true })
  assert.deepEqual(input.handleInput(inputEvent('“')), { data: '“' })
  assert.equal(input.takeNativeInputFallback(firstId), null)

  const secondId = beginNativeInput(input, { code: 'Quote', key: '"', shiftKey: true })
  assert.deepEqual(input.handleInput(inputEvent('”')), { data: '”' })
  assert.equal(input.takeNativeInputFallback(secondId), null)
}

// GUI text inputs can submit a complete smart-quote pair and place their DOM
// caret between it. A terminal has no matching edit operation, so emit one
// alternating quote per keypress and cancel the pair insertion.
{
  const input = new TerminalInputHandler('win32')
  const firstId = beginNativeInput(input, { code: 'Quote', key: '"', shiftKey: true })
  assert.deepEqual(input.handleBeforeInput(inputEvent('“”')), { data: '“' })
  assert.equal(input.takeNativeInputFallback(firstId), null)

  const secondId = beginNativeInput(input, { code: 'Quote', key: '"', shiftKey: true })
  assert.deepEqual(input.handleBeforeInput(inputEvent('“”')), { data: '”' })
  assert.equal(input.takeNativeInputFallback(secondId), null)

  const singleFirstId = beginNativeInput(input, { code: 'Quote', key: "'" })
  assert.deepEqual(input.handleBeforeInput(inputEvent('‘’')), { data: '‘' })
  assert.equal(input.takeNativeInputFallback(singleFirstId), null)
}

// The emergency fallback emits the original ASCII key once when Chromium
// does not produce an input event.
{
  const input = new TerminalInputHandler('win32')
  const fallbackId = beginNativeInput(input, { code: 'Quote', key: '"', shiftKey: true })
  assert.equal(input.takeNativeInputFallback(fallbackId), '"')
  assert.equal(input.takeNativeInputFallback(fallbackId), null)
}

// All standard punctuation and number-row keys use the same native path.
{
  const cases = [
    { code: 'Digit1', key: '1' },
    { code: 'Digit1', key: '!', shiftKey: true },
    { code: 'Comma', key: ',' },
    { code: 'Period', key: '.' },
    { code: 'Semicolon', key: ':' },
    { code: 'BracketLeft', key: '【' }
  ]
  for (const event of cases) {
    const input = new TerminalInputHandler('win32')
    const fallbackId = beginNativeInput(input, event)
    assert.deepEqual(input.handleInput(inputEvent(event.key)), { data: event.key })
    assert.equal(input.takeNativeInputFallback(fallbackId), null)
  }
}

// Composition and keyCode 229 remain owned by xterm so number selection and
// normal Pinyin composition are not intercepted.
{
  const input = new TerminalInputHandler('win32')
  assert.equal(input.handleKeyEvent(key({ code: 'Quote', key: 'Process', keyCode: 229 })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'Digit2', key: '2', isComposing: true })), null)

  const fallbackId = beginNativeInput(input, { code: 'Digit2', key: '2' })
  input.compositionStart()
  assert.equal(input.takeNativeInputFallback(fallbackId), null)
  assert.equal(input.handleKeyEvent(key({ code: 'Digit2', key: '2' })), null)
  input.compositionEnd()
  assert.equal(input.handleKeyEvent(key({ code: 'KeyA', key: 'a' })), null)
}

// Terminal shortcuts and AltGraph-style input must keep xterm's normal path.
{
  const input = new TerminalInputHandler('win32')
  assert.equal(input.handleKeyEvent(key({ code: 'Quote', key: "'", ctrlKey: true })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'Quote', key: "'", altKey: true })), null)
  assert.equal(
    input.handleKeyEvent(key({ code: 'Backslash', key: '|', ctrlKey: true, altKey: true })),
    null
  )
}

// Windows IMEs can label Escape as Process/229 even when no composition
// session is active. An active composition still gets first refusal.
{
  const input = new TerminalInputHandler('win32')
  assert.deepEqual(
    input.handleKeyEvent(key({ code: 'Escape', key: 'Process', keyCode: 229, isComposing: true })),
    { kind: 'write', data: '\x1b' }
  )
  input.compositionStart()
  assert.equal(
    input.handleKeyEvent(key({ code: 'Escape', key: 'Process', keyCode: 229, isComposing: true })),
    null
  )
}

// Modifier release is state-free and cannot write terminal data or move the
// application cursor.
{
  const input = new TerminalInputHandler('win32')
  assert.equal(input.handleKeyEvent(key({ type: 'keyup', code: 'ShiftLeft', key: 'Shift' })), null)
}

{
  const input = new TerminalInputHandler('win32')
  assert.deepEqual(input.handleKeyEvent(key({ code: 'Enter', key: 'Enter', shiftKey: true })), {
    kind: 'write',
    data: '\x1b[13;28;13;1;16;1_'
  })
}

{
  const input = new TerminalInputHandler('linux')
  assert.equal(input.handleKeyEvent(key({ code: 'Quote', key: "'" })), null)
  assert.equal(input.handleKeyEvent(key({ code: 'Escape', key: 'Escape', keyCode: 27 })), null)
  assert.deepEqual(input.handleKeyEvent(key({ code: 'Enter', key: 'Enter', shiftKey: true })), {
    kind: 'write',
    data: '\n'
  })
}

console.log('terminal keyboard input tests passed')
