import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { AccountInput, AccountRecord, TlsMode } from '../../shared/types'
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

function toRecord(row: typeof accounts.$inferSelect): AccountRecord {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    tlsMode: row.tlsMode as TlsMode,
    rejectUnauthorized: Boolean(row.rejectUnauthorized),
    lastScript: row.lastScript,
    lastUsedAt: row.lastUsedAt,
    hasPassword: Boolean(row.passwordEnc)
  }
}

export function listAccounts(): AccountRecord[] {
  const database = openDb()
  return database.select().from(accounts).all().map(toRecord)
}

export function saveAccount(input: AccountInput): AccountRecord {
  const database = openDb()
  const passwordEnc =
    input.rememberPassword && input.password
      ? encryptPassword(input.password)
      : input.id
        ? database.select().from(accounts).where(eq(accounts.id, input.id)).get()?.passwordEnc
        : null

  const values = {
    host: input.host,
    port: input.port,
    username: input.username,
    tlsMode: input.tlsMode,
    rejectUnauthorized: input.rejectUnauthorized,
    passwordEnc: input.rememberPassword === false ? null : passwordEnc,
    lastUsedAt: Date.now()
  }

  if (input.id) {
    database.update(accounts).set(values).where(eq(accounts.id, input.id)).run()
    const row = database.select().from(accounts).where(eq(accounts.id, input.id)).get()
    if (!row) throw new Error('account missing after update')
    setLastAccount(row.id)
    return toRecord(row)
  }

  database.insert(accounts).values(values).run()
  const rows = database.select().from(accounts).all()
  const row = rows[rows.length - 1]
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

export function closeDb(): void {
  sqlite?.close()
  sqlite = null
  db = null
}
