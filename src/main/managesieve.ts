import net from 'node:net'
import tls from 'node:tls'
import type { Capabilities, CheckDiagnostic, SieveScript, TlsMode } from '../shared/types'

export type ConnectOptions = {
  host: string
  port: number
  username: string
  password: string
  tlsMode: TlsMode
  rejectUnauthorized: boolean
  timeoutMs?: number
}

export class ManageSieveError extends Error {
  status: 'NO' | 'BYE' | 'OK'
  constructor(message: string, status: 'NO' | 'BYE' | 'OK' = 'NO') {
    super(message)
    this.name = 'ManageSieveError'
    this.status = status
  }
}

type Response = {
  status: 'OK' | 'NO' | 'BYE'
  message: string
  lines: string[]
}

type SocketLike = net.Socket | tls.TLSSocket

function applySystemCa(): void {
  const t = tls as typeof tls & {
    getCACertificates?: (type?: string) => string[]
    setDefaultCACertificates?: (certs: string[]) => void
  }
  try {
    if (typeof t.getCACertificates === 'function' && typeof t.setDefaultCACertificates === 'function') {
      t.setDefaultCACertificates(t.getCACertificates('system'))
    }
  } catch {
    // Electron/Node may not expose this; rejectUnauthorized still applies.
  }
}

applySystemCa()

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function parseQuoted(line: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"\\])*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    out.push(m[1].replace(/\\([\\"])/g, '$1'))
  }
  return out
}

function unquoteScriptBody(lines: string[]): string {
  if (lines.length === 1 && lines[0].startsWith('"')) {
    const parts = parseQuoted(lines[0])
    if (parts.length === 1) return parts[0]
  }
  return lines.join('\n')
}

function capMap(lines: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (const line of lines) {
    const parts = parseQuoted(line)
    if (parts.length === 1) out[parts[0]] = true
    else if (parts.length >= 2) out[parts[0]] = parts[1]
  }
  return out
}

export function capabilitiesFromLines(lines: string[]): Capabilities {
  const caps = capMap(lines)
  const sasl = typeof caps.SASL === 'string' ? caps.SASL.split(/\s+/).filter(Boolean) : []
  const sieve = typeof caps.SIEVE === 'string' ? caps.SIEVE.split(/\s+/).filter(Boolean) : []
  return {
    implementation: typeof caps.IMPLEMENTATION === 'string' ? caps.IMPLEMENTATION : null,
    sasl,
    sieve,
    starttls: Boolean(caps.STARTTLS),
    checkscript: Boolean(caps.CHECKSCRIPT)
  }
}

export function parseCheckDiagnostics(message: string): CheckDiagnostic[] {
  const trimmed = message.replace(/^NO\s+/i, '').replace(/^"|"$/g, '').trim()
  if (!trimmed) return []
  const lineMatch = trimmed.match(/line\s+(\d+)\s*:?\s*(.*)/i)
  if (lineMatch) {
    return [{ line: Number(lineMatch[1]), message: lineMatch[2] || trimmed, severity: 'error' }]
  }
  return [{ line: null, message: trimmed, severity: 'error' }]
}

export class ManageSieveClient {
  private socket: SocketLike | null = null
  private buffer = Buffer.alloc(0)
  private waiters: Array<(chunk: Buffer) => void> = []
  private queue: Promise<unknown> = Promise.resolve()
  private knownNames = new Set<string>()
  private checkscriptFailed = false
  capabilities: Capabilities = {
    implementation: null,
    sasl: [],
    sieve: [],
    starttls: false,
    checkscript: false
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async connect(opts: ConnectOptions): Promise<Capabilities> {
    return this.enqueue(() => this.connectInner(opts))
  }

  private async connectInner(opts: ConnectOptions): Promise<Capabilities> {
    await this.closeSocket()
    this.knownNames.clear()
    this.checkscriptFailed = false
    const timeoutMs = opts.timeoutMs ?? 15000
    const socket = net.connect({ host: opts.host, port: opts.port })
    this.socket = socket
    this.attachSocket(socket)

    await this.waitConnect(socket, timeoutMs)
    const greet = await this.readResponse(timeoutMs)
    if (greet.status !== 'OK') {
      throw new ManageSieveError(greet.message || 'greeting failed', greet.status)
    }
    this.capabilities = capabilitiesFromLines(greet.lines)

    if (opts.tlsMode === 'starttls' || (opts.tlsMode === 'optional' && this.capabilities.starttls)) {
      try {
        await this.upgradeTls(opts)
      } catch (err) {
        if (opts.tlsMode === 'starttls') throw err
      }
    } else if (opts.tlsMode === 'plaintext' && this.capabilities.starttls) {
      // stay cleartext
    }

    await this.authenticate(opts.username, opts.password)
    return this.capabilities
  }

  private async upgradeTls(opts: ConnectOptions): Promise<void> {
    const sock = this.requireSocket()
    this.writeLine('STARTTLS')
    const st = await this.readResponse()
    if (st.status !== 'OK') {
      throw new ManageSieveError(st.message || 'STARTTLS failed', st.status)
    }
    this.detachSocket(sock)
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect(
        {
          socket: sock,
          servername: opts.host,
          rejectUnauthorized: opts.rejectUnauthorized
        },
        () => resolve(s)
      )
      s.on('error', reject)
    })
    this.socket = secure
    this.buffer = Buffer.alloc(0)
    this.attachSocket(secure)
    const post = await this.readResponse()
    if (post.status !== 'OK') {
      throw new ManageSieveError(post.message || 'post-TLS greeting failed', post.status)
    }
    this.capabilities = capabilitiesFromLines(post.lines)
  }

  private async authenticate(username: string, password: string): Promise<void> {
    const b64 = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64')
    this.writeLine(`AUTHENTICATE "PLAIN" ${quote(b64)}`)
    const res = await this.readResponse()
    if (res.status !== 'OK') {
      throw new ManageSieveError(res.message || 'authentication failed', res.status)
    }
  }

  listScripts(): Promise<SieveScript[]> {
    return this.enqueue(async () => {
      this.writeLine('LISTSCRIPTS')
      const res = await this.readResponse()
      if (res.status !== 'OK') throw new ManageSieveError(res.message, res.status)
      const scripts = res.lines.map((line) => {
        const names = parseQuoted(line)
        return { name: names[0] ?? line, active: /(?:^|\s)ACTIVE(?:\s|$)/i.test(line) }
      })
      this.knownNames = new Set(scripts.map((s) => s.name))
      return scripts
    })
  }

  getScript(name: string): Promise<string> {
    return this.enqueue(async () => {
      this.writeLine(`GETSCRIPT ${quote(name)}`)
      const res = await this.readResponse()
      if (res.status !== 'OK') throw new ManageSieveError(res.message, res.status)
      return unquoteScriptBody(res.lines)
    })
  }

  putScript(name: string, body: string): Promise<void> {
    return this.enqueue(async () => {
      await this.sendLiteralCommand(`PUTSCRIPT ${quote(name)}`, body)
      const res = await this.readResponse()
      if (res.status !== 'OK') throw new ManageSieveError(res.message, res.status)
      this.knownNames.add(name)
    })
  }

  setActive(name: string): Promise<void> {
    return this.enqueue(async () => {
      this.writeLine(`SETACTIVE ${quote(name)}`)
      const res = await this.readResponse()
      if (res.status !== 'OK') throw new ManageSieveError(res.message, res.status)
    })
  }

  deleteScript(name: string): Promise<void> {
    return this.enqueue(async () => {
      this.writeLine(`DELETESCRIPT ${quote(name)}`)
      const res = await this.readResponse()
      if (res.status !== 'OK') throw new ManageSieveError(res.message, res.status)
      this.knownNames.delete(name)
    })
  }

  checkScript(body: string): Promise<CheckDiagnostic[]> {
    return this.enqueue(async () => {
      if (!body.trim()) return []
      if (this.capabilities.checkscript && !this.checkscriptFailed) {
        const viaCommand = await this.checkScriptCommand(body)
        if (viaCommand !== null) return viaCommand
      }
      return this.checkViaPut(body)
    })
  }

  private async checkScriptCommand(body: string): Promise<CheckDiagnostic[] | null> {
    await this.sendLiteralCommand('CHECKSCRIPT', body)
    const res = await this.readResponse()
    if (res.status === 'OK') return []
    if (/unknown command|unrecognized command|bad command/i.test(res.message)) {
      this.checkscriptFailed = true
      this.capabilities.checkscript = false
      return null
    }
    return parseCheckDiagnostics(res.message || res.lines.join('\n'))
  }

  private checkTempName(): string {
    const base = 'SieveEditor.check.tmp'
    if (!this.knownNames.has(base)) return base
    let i = 1
    while (this.knownNames.has(`${base}.${i}`)) i++
    return `${base}.${i}`
  }

  /** RFC 5804: servers without CHECKSCRIPT validate via PUTSCRIPT, which does not store on syntax error. */
  private async checkViaPut(body: string): Promise<CheckDiagnostic[]> {
    const name = this.checkTempName()
    await this.sendLiteralCommand(`PUTSCRIPT ${quote(name)}`, body)
    const res = await this.readResponse()
    if (res.status !== 'OK') {
      return parseCheckDiagnostics(res.message || res.lines.join('\n'))
    }
    this.writeLine(`DELETESCRIPT ${quote(name)}`)
    const del = await this.readResponse()
    if (del.status === 'OK') this.knownNames.delete(name)
    return []
  }

  logout(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.socket) return
      try {
        this.writeLine('LOGOUT')
        await this.readResponse(4000)
      } catch {
        // ignore
      }
      await this.closeSocket()
    })
  }

  private async sendLiteralCommand(command: string, body: string): Promise<void> {
    const buf = Buffer.from(body, 'utf8')
    this.writeLine(`${command} {${buf.length}+}`)
    const sock = this.requireSocket()
    await new Promise<void>((resolve, reject) => {
      sock.write(buf, (err) => (err ? reject(err) : resolve()))
    })
    sock.write('\r\n')
  }

  private attachSocket(socket: SocketLike): void {
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private detachSocket(socket: SocketLike): void {
    socket.off('data', this.onData)
    socket.off('error', this.onError)
    socket.off('close', this.onClose)
  }

  private onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w(Buffer.alloc(0))
  }

  private onError = (): void => {
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w(Buffer.alloc(0))
  }

  private onClose = (): void => {
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w(Buffer.alloc(0))
  }

  private requireSocket(): SocketLike {
    if (!this.socket) throw new ManageSieveError('not connected')
    return this.socket
  }

  private writeLine(line: string): void {
    this.requireSocket().write(line.endsWith('\r\n') ? line : `${line}\r\n`)
  }

  private waitConnect(socket: net.Socket, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ManageSieveError('TCP connect timeout')), timeoutMs)
      socket.once('connect', () => {
        clearTimeout(t)
        resolve()
      })
      socket.once('error', (err) => {
        clearTimeout(t)
        reject(err)
      })
    })
  }

  private async readResponse(timeoutMs = 15000): Promise<Response> {
    const deadline = Date.now() + timeoutMs
    const textLines: string[] = []

    while (Date.now() < deadline) {
      const line = await this.readLine(deadline - Date.now())
      const lit = line.match(/\{(\d+)\+?\}\s*$/)
      if (lit) {
        const n = Number(lit[1])
        const data = await this.readBytes(n, deadline - Date.now())
        textLines.push(data.toString('utf8'))
        const rest = await this.readLine(deadline - Date.now())
        if (/^(OK|NO|BYE)\b/i.test(rest)) {
          return this.finish(rest, textLines)
        }
        if (rest) textLines.push(rest)
        continue
      }
      if (/^(OK|NO|BYE)\b/i.test(line)) {
        return this.finish(line, textLines)
      }
      if (line.length) textLines.push(line)
    }
    throw new ManageSieveError('response timeout')
  }

  private finish(statusLine: string, lines: string[]): Response {
    const status = statusLine.slice(0, 2).toUpperCase() as Response['status']
    const message = statusLine.replace(/^(OK|NO|BYE)\s*/i, '').replace(/^"|"$/g, '')
    return { status, message: message || statusLine, lines }
  }

  private async readLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + Math.max(1, timeoutMs)
    while (Date.now() < deadline) {
      const idx = this.buffer.indexOf('\n')
      if (idx >= 0) {
        let line = this.buffer.subarray(0, idx)
        this.buffer = this.buffer.subarray(idx + 1)
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
        return line.toString('utf8')
      }
      await this.waitData(deadline - Date.now())
    }
    throw new ManageSieveError('line timeout')
  }

  private async readBytes(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + Math.max(1, timeoutMs)
    while (this.buffer.length < n) {
      if (Date.now() >= deadline) throw new ManageSieveError('literal timeout')
      await this.waitData(deadline - Date.now())
    }
    const data = this.buffer.subarray(0, n)
    this.buffer = this.buffer.subarray(n)
    return Buffer.from(data)
  }

  private waitData(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ManageSieveError('socket timeout')), Math.max(1, timeoutMs))
      this.waiters.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async closeSocket(): Promise<void> {
    const sock = this.socket
    this.socket = null
    this.buffer = Buffer.alloc(0)
    if (!sock) return
    this.detachSocket(sock)
    sock.destroy()
  }
}
