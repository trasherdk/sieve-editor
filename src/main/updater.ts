import { app, dialog, shell, type BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawn } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { APP_NAME, GITHUB_OWNER, GITHUB_REPO } from '../shared/app'
import type { UpdateChannel } from '../shared/types'
import { getUpdateChannel, getUpdateDownloadDir, setUpdateDownloadDir } from './db'

const REPO = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`
const FEED = `${REPO}/releases/latest`
const RELEASES = `${REPO}/releases?per_page=30`

type Channel = 'nsis' | 'appimage' | 'portable' | 'page'

type GithubRelease = {
  tag_name: string
  html_url: string
  draft?: boolean
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

type SemVer = { core: [number, number, number]; pre: Array<string | number> | null }

function parseSemver(value: string): SemVer {
  const raw = value.replace(/^v/i, '')
  const dash = raw.indexOf('-')
  const corePart = dash === -1 ? raw : raw.slice(0, dash)
  const prePart = dash === -1 ? '' : raw.slice(dash + 1)
  const nums = corePart.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pre = prePart
    ? prePart.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : null
  return { core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre }
}

function compareSemver(left: SemVer, right: SemVer): number {
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i]
  }
  if (!left.pre && !right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < length; i++) {
    const a = left.pre[i]
    const b = right.pre[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNum = typeof a === 'number'
    const bNum = typeof b === 'number'
    if (aNum && bNum) return a - b
    if (aNum) return -1
    if (bNum) return 1
    return a < b ? -1 : 1
  }
  return 0
}

function isNewer(remote: string, local: string): boolean {
  return compareSemver(parseSemver(remote), parseSemver(local)) > 0
}

function tagVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

const RELEASE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'sieve-editor'
}

function releaseKind(tag: string): 'stable' | 'beta' | 'rc' | null {
  const version = tag.replace(/^v/i, '')
  if (/^\d+\.\d+\.\d+$/.test(version)) return 'stable'
  if (/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) return 'beta'
  if (/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) return 'rc'
  return null
}

function channelAllows(tag: string, channel: UpdateChannel): boolean {
  if (channel === 'off') return false
  const kind = releaseKind(tag)
  if (kind === 'stable') return true
  if (channel === 'beta') return kind === 'beta' || kind === 'rc'
  if (channel === 'rc') return kind === 'rc'
  return false
}

async function latestRelease(): Promise<GithubRelease> {
  const res = await fetch(FEED, { headers: RELEASE_HEADERS })
  if (!res.ok) throw new Error(`GitHub releases ${res.status}`)
  return (await res.json()) as GithubRelease
}

async function listedReleases(): Promise<GithubRelease[]> {
  const res = await fetch(RELEASES, { headers: RELEASE_HEADERS })
  if (!res.ok) throw new Error(`GitHub releases ${res.status}`)
  const body = (await res.json()) as unknown
  if (!Array.isArray(body)) throw new Error('GitHub releases returned an unexpected list')
  return body as GithubRelease[]
}

async function chosenRelease(): Promise<GithubRelease | null> {
  const channel = getUpdateChannel()
  if (channel === 'off') return null
  if (channel === 'stable') return latestRelease()
  const rows = (await listedReleases()).filter((release) => !release.draft && channelAllows(release.tag_name, channel))
  rows.sort((left, right) =>
    compareSemver(parseSemver(tagVersion(right.tag_name)), parseSemver(tagVersion(left.tag_name)))
  )
  return rows[0] ?? null
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

function yieldDialogs(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150))
}

async function askSavePath(defaultPath: string, extensions: string[]): Promise<string | null> {
  await yieldDialogs()
  const options: Electron.SaveDialogOptions = {
    title: `Choose download location`,
    defaultPath,
    buttonLabel: 'Download',
    filters: [
      { name: 'Update', extensions },
      { name: 'All files', extensions: ['*'] }
    ],
    properties: process.platform === 'win32' ? ['dontAddToRecent'] : []
  }
  // Unparented: a second native dialog attached to the same window after
  // the Update prompt often never appears on Windows.
  const result = await dialog.showSaveDialog(options)
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

function launchFile(exe: string): void {
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dirname(exe) }).unref()
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function unlockedDest(chosen: string, lockedPath: string | null, assetName: string): string {
  if (!lockedPath || !samePath(chosen, lockedPath)) return chosen
  const named = join(dirname(chosen), basename(assetName.replaceAll('\\', '/')))
  if (!samePath(named, lockedPath)) return named
  const ext = extname(chosen)
  const stem = basename(chosen, ext)
  return join(dirname(chosen), `${stem}-new${ext}`)
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
  const saved = getUpdateDownloadDir()
  if (saved && existsSync(saved)) return saved
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
  const locked =
    kind === 'portable'
      ? portableExePath()
      : kind === 'appimage'
        ? process.env.APPIMAGE || null
        : null
  const dest = unlockedDest(chosen, locked, asset.name)
  try {
    setUpdateDownloadDir(dirname(dest))
    await downloadFile(asset.browser_download_url, dest, asset.size)
    if (kind === 'appimage') {
      try {
        chmodSync(dest, 0o755)
      } catch {
        /* launch may still work */
      }
    }
    await askToApply(kind, () => {
      launchFile(dest)
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
  if (getUpdateChannel() === 'off') {
    if (manual) {
      await showBox({
        type: 'info',
        title: APP_NAME,
        message: 'Updates are turned off.',
        detail: 'Choose a channel in Settings to check again.',
        buttons: ['OK']
      })
    }
    return
  }
  if (checking) return
  checking = true
  try {
    const kind = channel()
    const release = await chosenRelease()
    if (!release) {
      if (manual) await showUpToDate()
      return
    }
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
