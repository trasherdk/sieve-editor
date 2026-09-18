import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import Database from 'better-sqlite3'
import { and, desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { AccountInput, AccountRecord, EditorPrefs, OpenTabs, TlsMode } from '../../shared/types'
import { DEFAULT_INDENT_WITH_TABS, DEFAULT_TAB_SIZE } from '../../shared/types'
import { accounts, settings } from './schema'

let sqlite: Database.Database | null = null
let db: ReturnType<typeof drizzle> | null = null

function migrationsFolder(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'drizzle')
  return join(app.getAppPath(), 'drizzle')
}

export function openDb(): ReturnType<typeof drizzle> {
  if (db) return db
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'sieve.sqlite')
  sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: migrationsFolder() })
  ensureSettings()
  return db
}

function ensureSettings(): void {
  const database = openDb()
  const row = database.select().from(settings).where(eq(settings.id, 1)).get()
  if (!row) {
    database.insert(settings).values({ id: 1 }).run()
  }
}

function encryptPassword(password: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(password).toString('base64')
}

export function decryptPassword(blob: string | null | undefined): string | null {
  if (!blob) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return null
  }
}

function parseOpenTabs(raw: string | null | undefined): OpenTabs | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { names?: unknown; active?: unknown }
    if (!Array.isArray(parsed.names)) return null
    const names = parsed.names.filter((n): n is string => typeof n === 'string' && n.length > 0)
    const active = typeof parsed.active === 'string' ? parsed.active : null
    return { names, active }
  } catch {
    return null
  }
}

function toRecord(row: typeof accounts.$inferSelect): AccountRecord {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    tlsMode: row.tlsMode as TlsMode,
    rejectUnauthorized: Boolean(row.rejectUnauthorized),
    lastScript: row.lastScript,
    openTabs: parseOpenTabs(row.openTabs),
    lastUsedAt: row.lastUsedAt,
    hasPassword: Boolean(row.passwordEnc)
  }
}

export function listAccounts(): AccountRecord[] {
  const database = openDb()
  return database.select().from(accounts).orderBy(desc(accounts.lastUsedAt)).all().map(toRecord)
}

function findByIdentity(
  database: ReturnType<typeof openDb>,
  host: string,
  port: number,
  username: string
): typeof accounts.$inferSelect | undefined {
  return database
    .select()
    .from(accounts)
    .where(and(eq(accounts.host, host), eq(accounts.port, port), eq(accounts.username, username)))
    .get()
}

export function saveAccount(input: AccountInput): AccountRecord {
  const database = openDb()
  const match = findByIdentity(database, input.host, input.port, input.username)
  const id = match?.id ?? input.id
  const existing = id ? database.select().from(accounts).where(eq(accounts.id, id)).get() : undefined
  const passwordEnc =
    input.rememberPassword && input.password
      ? encryptPassword(input.password)
      : input.rememberPassword === false
        ? null
        : (existing?.passwordEnc ?? null)

  const values = {
    host: input.host,
    port: input.port,
    username: input.username,
    tlsMode: input.tlsMode,
    rejectUnauthorized: input.rejectUnauthorized,
    passwordEnc,
    lastUsedAt: Date.now()
  }

  if (existing) {
    database.update(accounts).set(values).where(eq(accounts.id, existing.id)).run()
    const row = database.select().from(accounts).where(eq(accounts.id, existing.id)).get()
    if (!row) throw new Error('account missing after update')
    setLastAccount(row.id)
    return toRecord(row)
  }

  database.insert(accounts).values(values).run()
  const row = findByIdentity(database, input.host, input.port, input.username)
  if (!row) throw new Error('account missing after insert')
  setLastAccount(row.id)
  return toRecord(row)
}

export function removeAccount(id: number): void {
  const database = openDb()
  database.delete(accounts).where(eq(accounts.id, id)).run()
}

export function getAccount(id: number): typeof accounts.$inferSelect | undefined {
  return openDb().select().from(accounts).where(eq(accounts.id, id)).get()
}

export function setLastScript(id: number, name: string | null): void {
  openDb().update(accounts).set({ lastScript: name, lastUsedAt: Date.now() }).where(eq(accounts.id, id)).run()
}

export function setOpenTabs(id: number, session: OpenTabs): void {
  const names = [...new Set(session.names.filter(Boolean))]
  const active = session.active && names.includes(session.active) ? session.active : (names[names.length - 1] ?? null)
  openDb()
    .update(accounts)
    .set({
      openTabs: JSON.stringify({ names, active }),
      lastScript: active,
      lastUsedAt: Date.now()
    })
    .where(eq(accounts.id, id))
    .run()
}

export function setLastAccount(id: number): void {
  openDb().update(settings).set({ lastAccountId: id }).where(eq(settings.id, 1)).run()
}

export function getWindowBounds(): { x?: number; y?: number; width: number; height: number } {
  const row = openDb().select().from(settings).where(eq(settings.id, 1)).get()
  return {
    x: row?.windowX ?? undefined,
    y: row?.windowY ?? undefined,
    width: row?.windowWidth ?? 1100,
    height: row?.windowHeight ?? 740
  }
}

export function saveWindowBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  openDb()
    .update(settings)
    .set({
      windowX: bounds.x,
      windowY: bounds.y,
      windowWidth: bounds.width,
      windowHeight: bounds.height
    })
    .where(eq(settings.id, 1))
    .run()
}

function clampTabSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TAB_SIZE
  return Math.min(8, Math.max(1, Math.round(n)))
}

export function getEditorPrefs(): EditorPrefs {
  const row = openDb().select().from(settings).where(eq(settings.id, 1)).get()
  return {
    indentWithTabs: row?.indentWithTabs ?? DEFAULT_INDENT_WITH_TABS,
    tabSize: clampTabSize(row?.tabSize ?? DEFAULT_TAB_SIZE)
  }
}

export function saveEditorPrefs(prefs: EditorPrefs): EditorPrefs {
  const next = {
    indentWithTabs: Boolean(prefs.indentWithTabs),
    tabSize: clampTabSize(prefs.tabSize)
  }
  openDb().update(settings).set(next).where(eq(settings.id, 1)).run()
  return next
}

export function getUpdateDownloadDir(): string | null {
  const dir = openDb().select().from(settings).where(eq(settings.id, 1)).get()?.updateDownloadDir
  return dir && dir.length > 0 ? dir : null
}

export function setUpdateDownloadDir(dir: string): void {
  openDb().update(settings).set({ updateDownloadDir: dir }).where(eq(settings.id, 1)).run()
}

export function closeDb(): void {
  sqlite?.close()
  sqlite = null
  db = null
}
