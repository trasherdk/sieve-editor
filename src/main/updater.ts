import { app, dialog, shell, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import electronUpdater from 'electron-updater'
import { spawn } from 'node:child_process'
import { createWriteStream, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { APP_NAME, GITHUB_OWNER, GITHUB_REPO } from '../shared/app'

const FEED = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

type Channel = 'nsis' | 'appimage' | 'portable' | 'page'

type GithubRelease = {
  tag_name: string
  html_url: string
  assets: { name: string; browser_download_url: string; size: number }[]
}

let started = false
let checking = false
let updaterReady = false
let getWindow: () => BrowserWindow | null = () => null

function currentWindow(): BrowserWindow | null {
  const w = getWindow()
  return w && !w.isDestroyed() ? w : null
}

function showBox(box: Electron.MessageBoxOptions) {
  const w = currentWindow()
  if (w) return dialog.showMessageBox(w, box)
  return dialog.showMessageBox(box)
}

function channel(): Channel {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'appimage'
  if (process.platform === 'win32') return 'nsis'
  return 'page'
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
}

function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

function tagVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

async function latestRelease(): Promise<GithubRelease> {
  const res = await fetch(FEED, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sieve-editor'
    }
  })
  if (!res.ok) throw new Error(`GitHub releases ${res.status}`)
  return (await res.json()) as GithubRelease
}

function autoUpdater() {
  const { autoUpdater: updater } = electronUpdater
  if (!updaterReady) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.logger = {
      info: (...a) => console.log('[updater]', ...a),
      warn: (...a) => console.warn('[updater]', ...a),
      error: (...a) => console.error('[updater]', ...a),
      debug: (...a) => console.debug('[updater]', ...a)
    }
    if (process.platform === 'win32') {
      const nsis = updater as typeof updater & {
        verifyUpdateCodeSignature: (
          publisherName: string[],
          path: string
        ) => Promise<string | null>
      }
      nsis.verifyUpdateCodeSignature = async () => null
    }
    updater.on('download-progress', (p) => {
      currentWindow()?.setProgressBar(Math.min(1, Math.max(0, p.percent / 100)))
    })
    updater.on('update-downloaded', () => {
      currentWindow()?.setProgressBar(-1)
    })
    updaterReady = true
  }
  return updater
}

async function askToUpdate(version: string): Promise<boolean> {
  const { response } = await showBox({
    type: 'info',
    title: `${APP_NAME} update`,
    message: `Version ${version} is available.`,
    detail: `You are running ${app.getVersion()}. Update now?`,
    buttons: ['Update', 'Not now'],
    defaultId: 0,
    cancelId: 1
  })
  return response === 0
}

async function askToRestart(install: () => void): Promise<void> {
  const { response } = await showBox({
    type: 'info',
    title: `${APP_NAME} update`,
    message: 'The update is ready to install.',
    detail: `Restart ${APP_NAME} now?`,
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) install()
}

async function showUpToDate(): Promise<void> {
  await showBox({
    type: 'info',
    title: APP_NAME,
    message: `${APP_NAME} ${app.getVersion()} is up to date.`,
    buttons: ['OK']
  })
}

async function showUpdateError(err: unknown, prefix: string): Promise<void> {
  await showBox({
    type: 'error',
    title: `${APP_NAME} update`,
    message: prefix,
    detail: err instanceof Error ? err.message : String(err),
    buttons: ['OK']
  })
}

async function openReleasePage(url: string, version: string, reason: string): Promise<void> {
  const { response } = await showBox({
    type: 'info',
    title: `${APP_NAME} update`,
    message: `Version ${version} is available.`,
    detail: `${reason}\n\nOpen the GitHub release?`,
    buttons: ['Open download', 'Not now'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) await shell.openExternal(url)
}

function portableExePath(): string | null {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  if (!dir) return null
  if (process.env.PORTABLE_EXECUTABLE_FILE) return process.env.PORTABLE_EXECUTABLE_FILE
  try {
    const names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.exe'))
    if (names.length === 1) return join(dir, names[0])
    const portable = names.find((f) => /portable/i.test(f))
    if (portable) return join(dir, portable)
    if (names[0]) return join(dir, names[0])
  } catch {
    return null
  }
  return null
}

async function downloadFile(url: string, dest: string, size?: number): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'sieve-editor' } })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const w = currentWindow()
  const total = size || Number(res.headers.get('content-length') || 0)
  const reader = res.body.getReader()
  const stream = createWriteStream(dest)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (!stream.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => stream.once('drain', resolve))
      }
      if (total) w?.setProgressBar(received / total)
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    stream.destroy()
    throw err
  } finally {
    w?.setProgressBar(-1)
  }
}

function portableAssetFileName(assetName: string): string {
  const base = basename(assetName.replaceAll('\\', '/'))
  if (!/^[A-Za-z0-9._-]+\.exe$/i.test(base)) return ''
  return base
}

function quitAndReplacePortable(downloaded: string, oldExe: string, nextExe: string): void {
  const ps1 = join(tmpdir(), 'sieve-editor-update.ps1')
  const same = oldExe.toLowerCase() === nextExe.toLowerCase()
  const script = [
    'param(',
    '  [Parameter(Mandatory)][int]$ProcessId,',
    '  [Parameter(Mandatory)][string]$Downloaded,',
    '  [Parameter(Mandatory)][string]$OldExe,',
    '  [Parameter(Mandatory)][string]$NextExe,',
    '  [Parameter(Mandatory)][string]$Overwrite',
    ')',
    'Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue',
    'Start-Sleep -Milliseconds 400',
    '$ok = $false',
    'for ($i = 0; $i -lt 25 -and -not $ok; $i++) {',
    '  try {',
    '    if ($Overwrite -eq "1") {',
    '      Copy-Item -LiteralPath $Downloaded -Destination $NextExe -Force',
    '      Remove-Item -LiteralPath $Downloaded -Force -ErrorAction SilentlyContinue',
    '    } else {',
    '      Move-Item -LiteralPath $Downloaded -Destination $NextExe -Force',
    '      if (Test-Path -LiteralPath $OldExe) {',
    '        Remove-Item -LiteralPath $OldExe -Force -ErrorAction SilentlyContinue',
    '      }',
    '    }',
    '    $ok = $true',
    '  } catch {',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    '}',
    'if ($ok) { Start-Process -FilePath $NextExe }',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    ''
  ].join('\r\n')
  writeFileSync(ps1, script)
  spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      ps1,
      String(process.pid),
      downloaded,
      oldExe,
      nextExe,
      same ? '1' : '0'
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref()
  app.quit()
}

async function updatePortable(release: GithubRelease): Promise<void> {
  const version = tagVersion(release.tag_name)
  const asset = release.assets.find((a) => /portable\.exe$/i.test(a.name))
  const oldExe = portableExePath()
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  const nextName = asset ? portableAssetFileName(asset.name) : ''
  if (!asset || !oldExe || !dir || !nextName) {
    await openReleasePage(
      release.html_url,
      version,
      'Could not find a portable download for this install.'
    )
    return
  }
  if (!(await askToUpdate(version))) return
  const dest = join(dir, '.sieve-editor-update.exe')
  const nextExe = join(dir, nextName)
  try {
    await downloadFile(asset.browser_download_url, dest, asset.size)
    await askToRestart(() => quitAndReplacePortable(dest, oldExe, nextExe))
  } catch (err) {
    await showUpdateError(err, 'The update could not be downloaded.')
  }
}

async function updateWithElectron(manual: boolean): Promise<boolean> {
  const updater = autoUpdater()
  const result = await updater.checkForUpdates()
  const version = result?.updateInfo?.version
  if (!version || !isNewer(version, app.getVersion())) {
    if (manual) await showUpToDate()
    return true
  }
  if (!(await askToUpdate(version))) return true
  await updater.downloadUpdate()
  await askToRestart(() => updater.quitAndInstall())
  return true
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged || is.dev) {
    if (manual) {
      await showBox({
        type: 'info',
        title: APP_NAME,
        message: 'Updates are checked in packaged builds.',
        buttons: ['OK']
      })
    }
    return
  }
  if (checking) return
  checking = true
  try {
    const kind = channel()
    if (kind === 'nsis' || kind === 'appimage') {
      try {
        const handled = await updateWithElectron(manual)
        if (handled) return
      } catch (err) {
        console.error('[updater]', err)
      }
    }

    const release = await latestRelease()
    const version = tagVersion(release.tag_name)
    if (!isNewer(version, app.getVersion())) {
      if (manual) await showUpToDate()
      return
    }
    if (kind === 'portable' && process.platform === 'win32') {
      await updatePortable(release)
      return
    }
    await openReleasePage(
      release.html_url,
      version,
      kind === 'page'
        ? 'This package cannot apply an in-app installer. Download the new file from GitHub.'
        : 'In-app install was not available; download from GitHub instead.'
    )
  } catch (err) {
    console.error('[updater]', err)
    if (manual) await showUpdateError(err, 'Could not check for updates.')
  } finally {
    checking = false
  }
}

export function startAutoUpdate(nextGetWindow: () => BrowserWindow | null): void {
  getWindow = nextGetWindow
  if (started) return
  if (is.dev || !app.isPackaged) return
  started = true
  void checkForUpdates(false)
}
