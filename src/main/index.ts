import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { APP_NAME } from '../shared/app'
import { MAX_SCRIPT_BYTES } from '../shared/types'
import type { AccountInput, Capabilities, EditorPrefs, OpenTabs, ScriptBodies, SieveScript } from '../shared/types'
import {
  closeDb,
  decryptPassword,
  getAccount,
  getEditorPrefs,
  getWindowBounds,
  listAccounts,
  openDb,
  removeAccount,
  saveAccount,
  saveEditorPrefs,
  saveWindowBounds,
  setLastScript,
  setOpenTabs,
} from './db'
import { ManageSieveClient } from './managesieve'
import { checkForUpdates, resumeIncompletePortableUpdate, startAutoUpdate } from './updater'
import { exportScriptFile, importScriptFile } from './files'

function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

function appTitle(): string {
  const version = app.getVersion()
  return isPortable() ? `${APP_NAME} ${version} Portable` : `${APP_NAME} ${version}`
}

function appIcon(): string | undefined {
  const icon = join(__dirname, '../../build/icon.png')
  return existsSync(icon) ? icon : undefined
}

const IDLE_MS = 15 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let client: ManageSieveClient | null = null
let connectedAccountId: number | null = null
let lastCapabilities: Capabilities | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void dropSession('Idle timeout', true)
  }, IDLE_MS)
}

function notifyDisconnected(reason: string): void {
  mainWindow?.webContents.send('sieve:disconnected', reason)
}

async function dropSession(reason: string, notify: boolean): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const c = client
  client = null
  connectedAccountId = null
  lastCapabilities = null
  if (c) {
    c.onDrop = null
    await c.logout()
  }
  if (notify) notifyDisconnected(reason)
}

async function disconnect(): Promise<void> {
  await dropSession('Disconnected', false)
}

function bindClientDrop(c: ManageSieveClient): void {
  c.onDrop = (reason) => {
    if (client !== c) return
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    client = null
    connectedAccountId = null
    lastCapabilities = null
    notifyDisconnected(reason)
  }
}

function requireClient(): ManageSieveClient {
  if (!client) throw new Error('Not connected')
  touchIdle()
  return client
}

async function fetchBodies(c: ManageSieveClient, scripts: SieveScript[]): Promise<ScriptBodies> {
  const bodies: ScriptBodies = {}
  for (const script of scripts) {
    try {
      bodies[script.name] = await c.getScript(script.name)
    } catch {
      bodies[script.name] = ''
    }
  }
  return bodies
}

/** LISTSCRIPTS plus GETSCRIPT for every personal script (needed to walk include). */
async function snapshot(): Promise<{ scripts: SieveScript[]; bodies: ScriptBodies }> {
  const c = requireClient()
  const scripts = await c.listScripts()
  const bodies = await fetchBodies(c, scripts)
  return { scripts, bodies }
}

function createWindow(): void {
  openDb()
  const bounds = getWindowBounds()
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: appTitle(),
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    startAutoUpdate(() => mainWindow)
  })
  mainWindow.on('close', () => {
    if (!mainWindow) return
    const b = mainWindow.getBounds()
    saveWindowBounds(b)
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function wrapIpc<T>(fn: () => Promise<T> | T): Promise<T> {
  return Promise.resolve()
    .then(fn)
    .catch((err: unknown) => {
      throw new Error(err instanceof Error ? err.message : String(err))
    })
}

function registerIpc(): void {
  ipcMain.handle('ping', () => 'pong')

  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    title: appTitle(),
    portable: isPortable()
  }))

  ipcMain.handle('app:checkForUpdates', () => wrapIpc(() => checkForUpdates(true)))

  ipcMain.handle('files:export', (_e, suggestedName: string, content: string) =>
    wrapIpc(() => exportScriptFile(mainWindow, suggestedName, content))
  )

  ipcMain.handle('files:import', () => wrapIpc(() => importScriptFile(mainWindow)))

  ipcMain.handle('accounts:list', () => wrapIpc(() => listAccounts()))

  ipcMain.handle('accounts:save', (_e, input: AccountInput) => wrapIpc(() => saveAccount(input)))

  ipcMain.handle('accounts:remove', (_e, id: number) => wrapIpc(() => removeAccount(id)))

  ipcMain.handle('accounts:setOpenTabs', (_e, id: number, session: OpenTabs) =>
    wrapIpc(() => setOpenTabs(id, session))
  )

  ipcMain.handle('sieve:connect', async (_e, input: AccountInput) => {
    await disconnect()
    const stored = input.id ? getAccount(input.id)?.passwordEnc ?? null : null
    const password = input.password || decryptPassword(stored)
    if (!password) throw new Error('Password required')
    const saved = saveAccount({ ...input, rememberPassword: input.rememberPassword ?? Boolean(input.password) })
    const next = new ManageSieveClient()
    try {
      lastCapabilities = await next.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password,
        tlsMode: input.tlsMode,
        rejectUnauthorized: input.rejectUnauthorized
      })
      bindClientDrop(next)
      client = next
      connectedAccountId = saved.id
      touchIdle()
      const scripts = await next.listScripts()
      const bodies = await fetchBodies(next, scripts)
      return { account: saved, capabilities: lastCapabilities, scripts, bodies }
    } catch (err) {
      await next.logout().catch(() => undefined)
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('sieve:disconnect', () => wrapIpc(() => disconnect()))

  ipcMain.handle('sieve:list', () => wrapIpc(() => requireClient().listScripts()))

  ipcMain.handle('sieve:snapshot', () => wrapIpc(() => snapshot()))

  ipcMain.handle('sieve:get', (_e, name: string) =>
    wrapIpc(async () => {
      const body = await requireClient().getScript(name)
      if (connectedAccountId) setLastScript(connectedAccountId, name)
      return body
    })
  )

  ipcMain.handle('sieve:put', (_e, name: string, body: string) =>
    wrapIpc(async () => {
      const bytes = Buffer.byteLength(body, 'utf8')
      if (bytes > MAX_SCRIPT_BYTES) {
        throw new Error(`Script is ${bytes} bytes; server limit is ${MAX_SCRIPT_BYTES} (sieve_maxscriptsize).`)
      }
      await requireClient().putScript(name, body)
      if (connectedAccountId) setLastScript(connectedAccountId, name)
    })
  )

  ipcMain.handle('sieve:activate', (_e, name: string) => wrapIpc(() => requireClient().setActive(name)))

  ipcMain.handle('sieve:deactivate', () => wrapIpc(() => requireClient().setActive('')))

  ipcMain.handle('sieve:delete', (_e, name: string) => wrapIpc(() => requireClient().deleteScript(name)))

  ipcMain.handle('sieve:check', (_e, body: string) => wrapIpc(() => requireClient().checkScript(body)))

  ipcMain.handle('sieve:capabilities', () => lastCapabilities)

  ipcMain.handle('prefs:get', () => wrapIpc(() => getEditorPrefs()))

  ipcMain.handle('prefs:save', (_e, prefs: EditorPrefs) => wrapIpc(() => saveEditorPrefs(prefs)))
}

app.whenReady().then(() => {
  app.setName(APP_NAME)
  electronApp.setAppUserModelId('dk.fumlersoft.sieve-editor')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc()
  if (resumeIncompletePortableUpdate()) return
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void disconnect()
  closeDb()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disconnect()
  closeDb()
})
