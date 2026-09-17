import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { MAX_SCRIPT_BYTES } from '../shared/types'
import type { AccountInput, Capabilities, ScriptBodies, SieveScript } from '../shared/types'
import {
  closeDb,
  decryptPassword,
  getAccount,
  getWindowBounds,
  listAccounts,
  openDb,
  removeAccount,
  saveAccount,
  saveWindowBounds,
  setLastScript
} from './db'
import { ManageSieveClient } from './managesieve'

const IDLE_MS = 15 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let client: ManageSieveClient | null = null
let connectedAccountId: number | null = null
let lastCapabilities: Capabilities | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void disconnect()
  }, IDLE_MS)
}

async function disconnect(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const c = client
  client = null
  connectedAccountId = null
  lastCapabilities = null
  if (c) await c.logout()
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
    title: 'Sieve',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
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

  ipcMain.handle('accounts:list', () => wrapIpc(() => listAccounts()))

  ipcMain.handle('accounts:save', (_e, input: AccountInput) => wrapIpc(() => saveAccount(input)))

  ipcMain.handle('accounts:remove', (_e, id: number) => wrapIpc(() => removeAccount(id)))

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

  ipcMain.handle('sieve:check', (_e, body: string) =>
    wrapIpc(async () => {
      try {
        return await requireClient().checkScript(body)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/unknown command|unrecognized/i.test(message)) return []
        throw err
      }
    })
  )

  ipcMain.handle('sieve:capabilities', () => lastCapabilities)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dk.fumlersoft.sieve-editor')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc()
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
