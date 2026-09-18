import { app, dialog, shell, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawn } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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

async function askToApply(kind: Channel, install: () => void): Promise<void> {
  const nsis = kind === 'nsis'
  const { response } = await showBox({
    type: 'info',
    title: `${APP_NAME} update`,
    message: nsis ? 'The installer is ready to run.' : 'The update is ready to install.',
    detail: nsis
      ? `Saved. Run the ${APP_NAME} installer now?`
      : `Restart ${APP_NAME} now?`,
    buttons: nsis ? ['Run', 'Later'] : ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) install()
}

async function askSavePath(defaultPath: string, extensions: string[]): Promise<string | null> {
  const options = {
    title: `Save ${APP_NAME} update`,
    defaultPath,
    buttonLabel: 'Save',
    filters: [
      { name: 'Update', extensions },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const w = currentWindow()
  const result = w ? await dialog.showSaveDialog(w, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  return result.filePath
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

const PORTABLE_PENDING = '.sieve-editor-update.exe'

function launchPortableExe(exe: string): void {
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dirname(exe) }).unref()
}

function orphanWscript(vbs: string, args: string[]): void {
  const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  const quoted = [wscript, '//B', '//Nologo', vbs, ...args]
    .map((a) => `"${a.replaceAll('"', '')}"`)
    .join(' ')
  spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `start "" ${quoted}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true
  }).unref()
}

function writeDeleteAfterExitScript(): string {
  const vbs = join(tmpdir(), 'sieve-editor-del.vbs')
  writeFileSync(
    vbs,
    [
      'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
      'pid = WScript.Arguments(0)',
      'target = WScript.Arguments(1)',
      'Do',
      '  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)',
      '  If procs.Count = 0 Then Exit Do',
      '  WScript.Sleep 200',
      'Loop',
      'WScript.Sleep 300',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'On Error Resume Next',
      'For i = 1 To 20',
      '  Err.Clear',
      '  fso.DeleteFile target, True',
      '  If Err.Number = 0 Then Exit For',
      '  WScript.Sleep 200',
      'Next',
      'fso.DeleteFile WScript.ScriptFullName, True',
      ''
    ].join('\r\n')
  )
  return vbs
}

function quitAndReplacePortable(downloaded: string, oldExe: string, nextExe: string): void {
  const same = oldExe.toLowerCase() === nextExe.toLowerCase()
  if (!same) {
    const sameDir = dirname(nextExe).toLowerCase() === dirname(oldExe).toLowerCase()
    if (sameDir) orphanWscript(writeDeleteAfterExitScript(), [String(process.pid), oldExe])
    launchPortableExe(nextExe)
    setTimeout(() => app.exit(0), 200)
    return
  }
  const vbs = join(tmpdir(), 'sieve-editor-update.vbs')
  writeFileSync(
    vbs,
    [
      'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
      'pid = WScript.Arguments(0)',
      'downloaded = WScript.Arguments(1)',
      'nextExe = WScript.Arguments(2)',
      'Do',
      '  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)',
      '  If procs.Count = 0 Then Exit Do',
      '  WScript.Sleep 200',
      'Loop',
      'WScript.Sleep 400',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set sh = CreateObject("WScript.Shell")',
      'On Error Resume Next',
      'done = False',
      'For i = 1 To 25',
      '  Err.Clear',
      '  fso.CopyFile downloaded, nextExe, True',
      '  If Err.Number = 0 Then',
      '    If fso.FileExists(downloaded) Then fso.DeleteFile downloaded, True',
      '    done = True',
      '    Exit For',
      '  End If',
      '  WScript.Sleep 200',
      'Next',
      'If done Then sh.Run """" & nextExe & """", 1, False',
      'fso.DeleteFile WScript.ScriptFullName, True',
      ''
    ].join('\r\n')
  )
  orphanWscript(vbs, [String(process.pid), downloaded, nextExe])
  setTimeout(() => app.exit(0), 200)
}

export function resumeIncompletePortableUpdate(): boolean {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  if (!dir) return false
  const pending = join(dir, PORTABLE_PENDING)
  if (!existsSync(pending)) return false
  const self = (process.env.PORTABLE_EXECUTABLE_FILE || portableExePath() || '').toLowerCase()
  if (self === pending.toLowerCase()) return false
  launchPortableExe(pending)
  setTimeout(() => app.exit(0), 200)
  return true
}

function findAsset(
  release: GithubRelease,
  kind: Channel
): GithubRelease['assets'][0] | undefined {
  if (kind === 'portable') return release.assets.find((a) => /portable\.exe$/i.test(a.name))
  if (kind === 'nsis') return release.assets.find((a) => /setup\.exe$/i.test(a.name))
  if (kind === 'appimage') return release.assets.find((a) => /\.AppImage$/i.test(a.name))
  return undefined
}

function defaultUpdateDir(kind: Channel): string {
  if (kind === 'portable' && process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR
  }
  if (kind === 'appimage' && process.env.APPIMAGE) return dirname(process.env.APPIMAGE)
  return app.getPath('downloads')
}

function assetExtensions(kind: Channel): string[] {
  if (kind === 'appimage') return ['AppImage']
  return ['exe']
}

async function updateFromRelease(release: GithubRelease, kind: Channel): Promise<void> {
  const version = tagVersion(release.tag_name)
  const asset = findAsset(release, kind)
  if (!asset) {
    await openReleasePage(
      release.html_url,
      version,
      'Could not find a download for this install.'
    )
    return
  }
  if (!(await askToUpdate(version))) return
  const suggested = join(defaultUpdateDir(kind), basename(asset.name.replaceAll('\\', '/')))
  const chosen = await askSavePath(suggested, assetExtensions(kind))
  if (!chosen) return
  const oldPortable = kind === 'portable' ? portableExePath() : null
  const runningAppImage = kind === 'appimage' ? process.env.APPIMAGE || null : null
  const locked =
    (oldPortable && chosen.toLowerCase() === oldPortable.toLowerCase()) ||
    (runningAppImage && chosen.toLowerCase() === runningAppImage.toLowerCase())
  const dest = locked
    ? kind === 'appimage'
      ? `${chosen}.new`
      : join(dirname(chosen), PORTABLE_PENDING)
    : chosen
  try {
    await downloadFile(asset.browser_download_url, dest, asset.size)
    if (kind === 'appimage') {
      try {
        chmodSync(dest, 0o755)
      } catch {
        /* launch may still work */
      }
    }
    await askToApply(kind, () => {
      if (kind === 'portable' && oldPortable) {
        quitAndReplacePortable(dest, oldPortable, chosen)
        return
      }
      spawn(dest, [], { detached: true, stdio: 'ignore', cwd: dirname(dest) }).unref()
      app.quit()
    })
  } catch (err) {
    await showUpdateError(err, 'The update could not be downloaded.')
  }
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
    const release = await latestRelease()
    const version = tagVersion(release.tag_name)
    if (!isNewer(version, app.getVersion())) {
      if (manual) await showUpToDate()
      return
    }
    if (kind === 'portable' || kind === 'nsis' || kind === 'appimage') {
      await updateFromRelease(release, kind)
      return
    }
    await openReleasePage(
      release.html_url,
      version,
      'This package cannot apply an in-app installer. Download the new file from GitHub.'
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
