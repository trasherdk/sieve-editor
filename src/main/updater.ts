import { app, dialog, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import electronUpdater from 'electron-updater'

let started = false

function showBox(win: BrowserWindow | null, box: Electron.MessageBoxOptions) {
  if (win && !win.isDestroyed()) return dialog.showMessageBox(win, box)
  return dialog.showMessageBox(box)
}

/** NSIS setup and Linux AppImage only. Portable and .deb stay manual. */
export function startAutoUpdate(getWindow: () => BrowserWindow | null): void {
  if (started) return
  if (is.dev || !app.isPackaged) return
  if (process.env.PORTABLE_EXECUTABLE_DIR) return
  if (process.platform === 'linux' && !process.env.APPIMAGE) return
  started = true

  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  if (process.platform === 'win32') {
    const nsis = autoUpdater as typeof autoUpdater & {
      verifyUpdateCodeSignature: (
        publisherName: string[],
        path: string
      ) => Promise<string | null>
    }
    nsis.verifyUpdateCodeSignature = async () => null
  }

  let accepted = false

  autoUpdater.on('update-available', (info) => {
    void askToUpdate(getWindow(), info.version)
  })

  autoUpdater.on('update-downloaded', () => {
    void askToInstall(getWindow())
  })

  autoUpdater.on('error', (err) => {
    if (!accepted) return
    void showBox(getWindow(), {
      type: 'error',
      title: 'Sieve update',
      message: 'The update could not be downloaded.',
      detail: err instanceof Error ? err.message : String(err),
      buttons: ['OK']
    })
  })

  async function askToUpdate(win: BrowserWindow | null, version: string): Promise<void> {
    const { response } = await showBox(win, {
      type: 'info',
      title: 'Sieve update',
      message: `Version ${version} is available.`,
      detail: `You are running ${app.getVersion()}. Update now?`,
      buttons: ['Update', 'Not now'],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return
    accepted = true
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      accepted = false
      await showBox(win, {
        type: 'error',
        title: 'Sieve update',
        message: 'The update could not be downloaded.',
        detail: err instanceof Error ? err.message : String(err),
        buttons: ['OK']
      })
    }
  }

  async function askToInstall(win: BrowserWindow | null): Promise<void> {
    const { response } = await showBox(win, {
      type: 'info',
      title: 'Sieve update',
      message: 'The update is ready to install.',
      detail: 'Restart Sieve now?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1
    })
    if (response === 0) autoUpdater.quitAndInstall()
  }

  void autoUpdater.checkForUpdates()
}
