import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  username: text('username').notNull(),
  tlsMode: text('tls_mode').notNull().default('starttls'),
  rejectUnauthorized: integer('reject_unauthorized', { mode: 'boolean' }).notNull().default(true),
  lastScript: text('last_script'),
  openTabs: text('open_tabs'),
  passwordEnc: text('password_enc'),
  lastUsedAt: integer('last_used_at')
})

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey().default(1),
  lastAccountId: integer('last_account_id'),
  windowX: integer('window_x'),
  windowY: integer('window_y'),
  windowWidth: integer('window_width'),
  windowHeight: integer('window_height'),
  indentWithTabs: integer('indent_with_tabs', { mode: 'boolean' }).notNull().default(true),
  tabSize: integer('tab_size').notNull().default(4)
})
