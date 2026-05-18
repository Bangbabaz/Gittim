// electron-builder afterPack hook.
//
// node-pty's macOS/Linux `spawn-helper` is a standalone executable that node-pty
// exec()s to launch the shell. Packing node-pty into `app.asar.unpacked` can
// drop the file's executable bit, so the packaged app crashes on the first PTY
// spawn (which happens immediately — a terminal pane mounts on launch). The
// `postinstall` chmod only fixes node_modules on the build machine, not the
// copy inside the packaged .app, so restore +x here for every prebuild dir.
// Windows uses winpty/conpty (no spawn-helper) — skip it.

const { readdirSync, existsSync, chmodSync } = require('fs')
const { join } = require('path')

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform !== 'darwin' && platform !== 'linux') return

  let resourcesDir
  if (platform === 'darwin') {
    const appBundle = readdirSync(context.appOutDir).find((n) => n.endsWith('.app'))
    if (!appBundle) return
    resourcesDir = join(context.appOutDir, appBundle, 'Contents', 'Resources')
  } else {
    resourcesDir = join(context.appOutDir, 'resources')
  }

  const prebuilds = join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds'
  )
  if (!existsSync(prebuilds)) return

  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    try {
      if (existsSync(helper)) {
        chmodSync(helper, 0o755)
        console.log(`[afterPack] chmod 0755 ${helper}`)
      }
    } catch (e) {
      console.warn(`[afterPack] could not chmod ${helper}: ${e.message}`)
    }
  }
}
