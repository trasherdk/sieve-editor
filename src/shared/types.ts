export const DEFAULT_TAB_SIZE = 4
export const DEFAULT_INDENT_WITH_TABS = true
export const MAX_SCRIPT_BYTES = 50 * 1024
export const DEFAULT_HOST = 'mail.fumlersoft.dk'
export const DEFAULT_PORT = 4190

export type EditorPrefs = {
  indentWithTabs: boolean
  tabSize: number
}

export type TlsMode = 'starttls' | 'optional' | 'plaintext'

export type AccountRecord = {
  id: number
  host: string
  port: number
  username: string
  tlsMode: TlsMode
  rejectUnauthorized: boolean
  lastScript: string | null
  lastUsedAt: number | null
  hasPassword: boolean
}

export type AccountInput = {
  id?: number
  host: string
  port: number
  username: string
  password?: string
  rememberPassword?: boolean
  tlsMode: TlsMode
  rejectUnauthorized: boolean
}

export type SieveScript = {
  name: string
  active: boolean
}

export type CheckDiagnostic = {
  line: number | null
  message: string
  severity: 'error' | 'warning'
}

export type Capabilities = {
  implementation: string | null
  sasl: string[]
  sieve: string[]
  starttls: boolean
  checkscript: boolean
  maxRedirects?: string
}

export type ScriptBodies = Record<string, string>

export type ScriptSnapshot = {
  scripts: SieveScript[]
  bodies: ScriptBodies
}

export type ConnectResult = {
  account: AccountRecord
  capabilities: Capabilities
  scripts: SieveScript[]
  bodies: ScriptBodies
}

export type SieveApi = {
  ping: () => Promise<string>
  accounts: {
    list: () => Promise<AccountRecord[]>
    save: (input: AccountInput) => Promise<AccountRecord>
    remove: (id: number) => Promise<void>
  }
  sieve: {
    connect: (input: AccountInput) => Promise<ConnectResult>
    disconnect: () => Promise<void>
    list: () => Promise<SieveScript[]>
    snapshot: () => Promise<ScriptSnapshot>
    get: (name: string) => Promise<string>
    put: (name: string, body: string) => Promise<void>
    activate: (name: string) => Promise<void>
    deactivate: () => Promise<void>
    delete: (name: string) => Promise<void>
    check: (body: string) => Promise<CheckDiagnostic[]>
    capabilities: () => Promise<Capabilities | null>
  }
  prefs: {
    get: () => Promise<EditorPrefs>
    save: (prefs: EditorPrefs) => Promise<EditorPrefs>
  }
}
