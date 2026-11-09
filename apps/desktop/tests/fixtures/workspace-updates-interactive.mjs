/** Operator-controlled qualification using the real workspace; synthetic payloads never execute. */
import { app, BrowserWindow, Menu, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Keep the private workspace open until the operator closes the control window or exits the application.
 * @param {object} options Real workspace and fixture-owned delivery, task, and installation controls.
 * @returns {Promise<void>} Resolves after operator exit and removal of control listeners.
 */
export async function runInteractiveUpdates({ mainWindow, server, fixture, checkMenu, control, root }) {
  const panel = new BrowserWindow({ title: 'Local update acceptance controls', width: 640, height: 460,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  const finished = Promise.withResolvers()
  const finish = () => finished.resolve()
  panel.once('closed', finish)
  app.once('before-quit', finish)
  let closing = false
  const originalInstall = fixture.updater.quitAndInstall
  fixture.updater.quitAndInstall = (...args) => {
    fixture.installations.push(args)
    void dialog.showMessageBox(panel, { type: 'info', title: 'Local acceptance finished',
      message: 'Download, verification, install confirmation, and task wrap-up are complete.',
      detail: 'The installer call was intercepted; nothing was installed and the app did not restart into the new version. Confirm to end this drill; rerun the command to start another round.',
      buttons: ['end the drill'] }).then(finish).catch(finish)
  }
  const action = (label, operation) => ({ label, click: () => {
    if (closing) return
    void Promise.resolve().then(operation).catch(error => {
      console.error(error)
      if (!panel.isDestroyed()) dialog.showErrorBox('Local acceptance action failed', String(error))
    })
  } })
  const select = mode => server.select(mode, '0.1.6-nightly.1')
  select('hold-download')
  const check = () => checkMenu.click()
  panel.setMenu(Menu.buildFromTemplate([
    { label: 'Update scenario', submenu: [
      action('Normal update (progress is kept after clicking download)', () => { server.policy('clear'); select('hold-download'); check() }),
      action('Forced update (progress is kept after clicking download)', () => { server.policy('force'); select('hold-download'); check() }),
      action('Allow the current download → Verification and install confirmation', () => server.release()),
      { type: 'separator' },
      action('Next download: verification fails', () => select('corrupt')),
      action('Next download: 404 fails', () => select('download-404')),
      action('Next download: back to normal', () => select('healthy')),
      action('Check failed', () => { select('feed-404'); check() }),
      action('No update available (use before downloading)', () => { server.select('healthy', '0.1.5-rc.1'); check() }),
      action('Clear forced-update block', () => { server.policy('clear'); check() }),
    ] },
    { label: 'Task status', submenu: [
      action('Add queued task', () => control('queue')),
      action('Clear queued tasks', () => control('clear')),
      action('Simulate task stop failure (this round only)', () => control('hold-shutdown')),
    ] },
    { label: 'window', submenu: [
      action('Back to app', () => { mainWindow.restore(); mainWindow.show(); mainWindow.focus() }),
      action('end the drill', finish),
    ] },
  ]))
  try {
    await panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN">
      <meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>body{font:16px/1.8 system-ui;padding:24px;color:#222}h2{margin-top:0}strong{color:#165dff}</style>
      <h2>Manual update acceptance · The installer is not run</h2>
      <p>Use the<strong>Update scenario</strong>menu at the top of this window to choose a normal or forced update, then click download in the app.</p>
      <p>Download keeps its progress so you can inspect it. Come back here and choose<strong>Allow the current download</strong>to enter verification and install confirmation.</p>
      <p>use<strong>Task status</strong>menu to add queued tasks and see the pre-install task warning. Choose a failure mode before downloading.</p>
      <p>The data and update servers are local isolated test servers. The download URL is a sample address. Close this window to end the drill; rerun the command to reset state.</p>
      </html>`)}`)
    console.log(`Interactive updater ready: ${root}`)
    await finished.promise
    closing = true
    await writeFile(join(root, 'interactive-result.json'), JSON.stringify({ installerExecuted: false,
      interceptedInstallations: fixture.installations.length, phases: fixture.states.map(state => state.phase) }, null, 2) + '\n')
  } finally {
    closing = true
    fixture.updater.quitAndInstall = originalInstall
    app.off('before-quit', finish)
    panel.off('closed', finish)
    if (!panel.isDestroyed()) panel.destroy()
  }
}
