import type { CheckDiagnostic } from './types'

/** Server SIEVE capability names. Null when the server list is unknown. */
export type SyntaxCheckOptions = {
  capabilities?: readonly string[] | null
}

type ArgKind = 'string' | 'string-list' | 'number' | 'addresses'

type TagArg =
  | 'none'
  | 'string'
  | 'string-list'
  | 'number'
  | 'rel'
  | 'comparator'
  | 'importance'
  | 'zone'
  | 'ret'
  | 'bymode'

type TagDef = {
  name: string
  arg: TagArg
  group?: string
  requires?: string | string[]
  /** Valid only when the named tag is also present. */
  with?: string
}

type WordSpec = {
  requires?: string | string[]
  tags?: TagDef[]
  args: ArgKind[]
  optionalArgs?: number
  /** A single string may precede the string-list (Cyrus flag variable / mailbox). */
  leadingString?: boolean
  /** A string-list may precede the last string-list when "variables" is required. */
  leadingList?: boolean
  block?: boolean
  requireGroups?: string[]
  requireTags?: string[]
}

type Tok = {
  kind: 'string' | 'number' | 'ident' | 'tag' | 'punct' | 'eof'
  i: number
  line: number
  text: string
}

const IDENT_START = /[A-Za-z_]/
const IDENT_CONT = /[A-Za-z0-9_]/
const MAX_ISSUES = 50
const ALWAYS = new Set(['comparator-i;octet', 'comparator-i;ascii-casemap'])
const COMPARATORS = new Set(['i;octet', 'i;ascii-casemap', 'i;ascii-numeric', 'i;unicode-casemap'])
const REL = new Set(['gt', 'ge', 'lt', 'le', 'eq', 'ne'])
const TEST_WORDS = new Set(['not', 'allof', 'anyof', 'true', 'false'])
const CONTROL_WORDS = new Set(['if', 'elsif', 'else', 'require', 'ihave', 'stop', 'error'])

const EQUIV: string[][] = [
  ['snooze', 'vnd.cyrus.snooze', 'x-cyrus-snooze'],
  ['vnd.cyrus.log', 'x-cyrus-log'],
  ['vnd.cyrus.jmapquery', 'x-cyrus-jmapquery'],
  ['processcalendar', 'vnd.cyrus.imip'],
  ['vnd.cyrus.redirect-multiple', 'redirect-multiple']
]

const matchTags: TagDef[] = [
  { name: 'is', arg: 'none', group: 'match' },
  { name: 'contains', arg: 'none', group: 'match' },
  { name: 'matches', arg: 'none', group: 'match' },
  { name: 'regex', arg: 'none', group: 'match', requires: 'regex' },
  { name: 'count', arg: 'rel', group: 'match', requires: 'relational' },
  { name: 'value', arg: 'rel', group: 'match', requires: 'relational' }
]

const listTag: TagDef = { name: 'list', arg: 'none', group: 'match', requires: 'extlists' }

const addrTags: TagDef[] = [
  { name: 'all', arg: 'none', group: 'addr' },
  { name: 'localpart', arg: 'none', group: 'addr' },
  { name: 'domain', arg: 'none', group: 'addr' },
  { name: 'user', arg: 'none', group: 'addr', requires: 'subaddress' },
  { name: 'detail', arg: 'none', group: 'addr', requires: 'subaddress' }
]

const comparatorTag: TagDef = { name: 'comparator', arg: 'comparator', group: 'comparator' }

const indexTags: TagDef[] = [
  { name: 'index', arg: 'number', requires: 'index' },
  { name: 'last', arg: 'none', requires: 'index', with: 'index' }
]

const mimeFlags: TagDef[] = [
  { name: 'mime', arg: 'none', requires: 'mime' },
  { name: 'anychild', arg: 'none', requires: 'mime' }
]

const mimeOpts: TagDef[] = [
  { name: 'type', arg: 'none', group: 'mimeopt', requires: 'mime' },
  { name: 'subtype', arg: 'none', group: 'mimeopt', requires: 'mime' },
  { name: 'contenttype', arg: 'none', group: 'mimeopt', requires: 'mime' },
  { name: 'param', arg: 'string-list', group: 'mimeopt', requires: 'mime' }
]

const setMods: TagDef[] = [
  { name: 'lower', arg: 'none', group: 'mod40' },
  { name: 'upper', arg: 'none', group: 'mod40' },
  { name: 'lowerfirst', arg: 'none', group: 'mod30' },
  { name: 'upperfirst', arg: 'none', group: 'mod30' },
  { name: 'quotewildcard', arg: 'none', group: 'mod20' },
  { name: 'quoteregex', arg: 'none', group: 'mod20', requires: 'regex' },
  { name: 'encodeurl', arg: 'none', requires: 'enotify' },
  { name: 'length', arg: 'none' }
]

const fccTags: TagDef[] = [
  { name: 'fcc', arg: 'string', requires: 'fcc' },
  { name: 'flags', arg: 'string-list', requires: 'imap4flags' },
  { name: 'specialuse', arg: 'string', requires: 'special-use' },
  { name: 'mailboxid', arg: 'string', requires: 'mailboxid' },
  { name: 'create', arg: 'none', requires: 'mailbox' }
]

const zoneTags: TagDef[] = [
  { name: 'zone', arg: 'zone', group: 'zone' },
  { name: 'originalzone', arg: 'none', group: 'zone' }
]

function tags(...groups: TagDef[][]): TagDef[] {
  return groups.flat()
}

function actions(): Map<string, WordSpec> {
  const filter: WordSpec = {
    requires: 'vnd.dovecot.filter',
    args: ['string', 'string-list'],
    optionalArgs: 1
  }
  const execute: WordSpec = {
    requires: 'vnd.dovecot.execute',
    tags: [
      { name: 'input', arg: 'string', group: 'input' },
      { name: 'pipe', arg: 'none', group: 'input' },
      { name: 'output', arg: 'string', requires: 'variables' }
    ],
    args: ['string', 'string-list'],
    optionalArgs: 1
  }
  const convert: WordSpec = { requires: 'convert', args: ['string', 'string', 'string-list'] }
  const map = new Map<string, WordSpec>([
    ['discard', { args: [] }],
    ['stop', { args: [] }],
    ['keep', { tags: [{ name: 'flags', arg: 'string-list', requires: 'imap4flags' }], args: [] }],
    [
      'redirect',
      {
        tags: [
          { name: 'copy', arg: 'none', requires: 'copy' },
          { name: 'list', arg: 'none', requires: 'extlists' },
          { name: 'notify', arg: 'string', requires: 'redirect-dsn' },
          { name: 'ret', arg: 'ret', requires: 'redirect-dsn' },
          { name: 'bytimerelative', arg: 'number', group: 'bytime', requires: 'redirect-deliverby' },
          { name: 'bytimeabsolute', arg: 'string', group: 'bytime', requires: 'redirect-deliverby' },
          { name: 'bymode', arg: 'bymode', requires: 'redirect-deliverby' },
          { name: 'bytrace', arg: 'none', requires: 'redirect-deliverby' }
        ],
        args: ['addresses']
      }
    ],
    [
      'fileinto',
      {
        requires: 'fileinto',
        tags: [
          { name: 'copy', arg: 'none', requires: 'copy' },
          { name: 'create', arg: 'none', requires: 'mailbox' },
          { name: 'flags', arg: 'string-list', requires: 'imap4flags' },
          { name: 'specialuse', arg: 'string', requires: 'special-use' },
          { name: 'mailboxid', arg: 'string', requires: 'mailboxid' }
        ],
        args: ['string']
      }
    ],
    ['reject', { requires: 'reject', args: ['string'] }],
    ['ereject', { requires: 'ereject', args: ['string'] }],
    [
      'vacation',
      {
        requires: 'vacation',
        tags: tags(
          [
            { name: 'days', arg: 'number' },
            { name: 'subject', arg: 'string' },
            { name: 'from', arg: 'string' },
            { name: 'addresses', arg: 'string-list' },
            { name: 'mime', arg: 'none' },
            { name: 'handle', arg: 'string' },
            { name: 'seconds', arg: 'number', requires: 'vacation-seconds' }
          ],
          fccTags
        ),
        args: ['string']
      }
    ],
    ['set', { requires: 'variables', tags: setMods, args: ['string', 'string'] }],
    ['setflag', { requires: 'imap4flags', args: ['string-list'], leadingString: true }],
    ['addflag', { requires: 'imap4flags', args: ['string-list'], leadingString: true }],
    ['removeflag', { requires: 'imap4flags', args: ['string-list'], leadingString: true }],
    [
      'include',
      {
        requires: 'include',
        tags: [
          { name: 'personal', arg: 'none', group: 'location' },
          { name: 'global', arg: 'none', group: 'location' },
          { name: 'once', arg: 'none' },
          { name: 'optional', arg: 'none' }
        ],
        args: ['string']
      }
    ],
    ['return', { requires: 'include', args: [] }],
    ['global', { requires: ['include', 'variables'], args: ['string-list'] }],
    ['addheader', { requires: 'editheader', tags: [{ name: 'last', arg: 'none' }], args: ['string', 'string'] }],
    [
      'deleteheader',
      {
        requires: 'editheader',
        tags: tags(
          [
            { name: 'index', arg: 'number' },
            { name: 'last', arg: 'none', with: 'index' }
          ],
          [comparatorTag],
          matchTags,
          [listTag]
        ),
        args: ['string', 'string-list'],
        optionalArgs: 1
      }
    ],
    [
      'notify',
      {
        requires: 'enotify',
        tags: tags(
          [
            { name: 'from', arg: 'string' },
            { name: 'importance', arg: 'importance' },
            { name: 'options', arg: 'string-list' },
            { name: 'message', arg: 'string' }
          ],
          fccTags
        ),
        args: ['string']
      }
    ],
    [
      'pipe',
      {
        requires: 'vnd.dovecot.pipe',
        tags: [
          { name: 'try', arg: 'none' },
          { name: 'copy', arg: 'none' }
        ],
        args: ['string', 'string-list'],
        optionalArgs: 1
      }
    ],
    ['filter', filter],
    ['execute', execute],
    ['convert', convert],
    [
      'foreverypart',
      { requires: 'mime', tags: [{ name: 'name', arg: 'string' }], args: [], block: true }
    ],
    ['break', { requires: 'mime', tags: [{ name: 'name', arg: 'string' }], args: [] }],
    [
      'replace',
      {
        requires: 'mime',
        tags: [
          { name: 'mime', arg: 'none' },
          { name: 'subject', arg: 'string' },
          { name: 'from', arg: 'string' }
        ],
        args: ['string']
      }
    ],
    [
      'enclose',
      {
        requires: 'mime',
        tags: [
          { name: 'subject', arg: 'string' },
          { name: 'headers', arg: 'string-list' }
        ],
        requireTags: ['subject', 'headers'],
        args: ['string']
      }
    ],
    [
      'extracttext',
      {
        requires: ['extracttext', 'variables'],
        tags: [{ name: 'first', arg: 'number' }],
        args: ['string']
      }
    ],
    ['error', { requires: 'ihave', args: ['string'] }],
    ['log', { requires: 'vnd.cyrus.log', args: ['string'] }],
    [
      'snooze',
      {
        requires: 'snooze',
        tags: [
          { name: 'mailbox', arg: 'string' },
          { name: 'create', arg: 'none', requires: 'mailbox' },
          { name: 'specialuse', arg: 'string', requires: 'special-use' },
          { name: 'mailboxid', arg: 'string', requires: 'mailboxid' },
          { name: 'addflags', arg: 'string-list', requires: 'imap4flags' },
          { name: 'removeflags', arg: 'string-list', requires: 'imap4flags' },
          { name: 'weekdays', arg: 'string-list' },
          { name: 'tzid', arg: 'string' }
        ],
        args: ['string-list']
      }
    ],
    [
      'processcalendar',
      {
        requires: 'processcalendar',
        tags: calendarTags(),
        args: []
      }
    ],
    [
      'processimip',
      {
        requires: 'vnd.cyrus.imip',
        tags: calendarTags(),
        args: []
      }
    ],
    [
      'implicit_keep_target',
      {
        requires: 'vnd.cyrus.implicit_keep_target',
        tags: [
          { name: 'specialuse', arg: 'string', requires: 'special-use' },
          { name: 'mailboxid', arg: 'string', requires: 'mailboxid' }
        ],
        args: ['string']
      }
    ]
  ])
  return map
}

function calendarTags(): TagDef[] {
  return [
    { name: 'allowpublic', arg: 'none' },
    { name: 'invitesonly', arg: 'none' },
    { name: 'updatesonly', arg: 'none' },
    { name: 'deletecancelled', arg: 'none' },
    { name: 'addresses', arg: 'string-list' },
    { name: 'organizers', arg: 'string', requires: 'extlists' },
    { name: 'calendarid', arg: 'string' },
    { name: 'outcome', arg: 'string', requires: 'variables' },
    { name: 'reason', arg: 'string', requires: 'variables' }
  ]
}

function tests(): Map<string, WordSpec> {
  const list = tags(matchTags, [listTag])
  const match = tags(matchTags, [comparatorTag])
  const map = new Map<string, WordSpec>([
    [
      'address',
      {
        tags: tags(addrTags, list, [comparatorTag], indexTags, mimeFlags),
        args: ['string-list', 'string-list']
      }
    ],
    [
      'envelope',
      {
        requires: 'envelope',
        tags: tags(addrTags, list, [comparatorTag]),
        args: ['string-list', 'string-list']
      }
    ],
    ['exists', { tags: mimeFlags, args: ['string-list'] }],
    [
      'header',
      {
        tags: tags(list, [comparatorTag], indexTags, mimeFlags, mimeOpts),
        args: ['string-list', 'string-list']
      }
    ],
    [
      'size',
      {
        tags: [
          { name: 'over', arg: 'none', group: 'size' },
          { name: 'under', arg: 'none', group: 'size' }
        ],
        requireGroups: ['size'],
        args: ['number']
      }
    ],
    [
      'body',
      {
        requires: 'body',
        tags: tags(
          [
            { name: 'raw', arg: 'none', group: 'body' },
            { name: 'text', arg: 'none', group: 'body' },
            { name: 'content', arg: 'string-list', group: 'body' }
          ],
          match
        ),
        args: ['string-list']
      }
    ],
    ['string', { requires: 'variables', tags: tags(list, [comparatorTag]), args: ['string-list', 'string-list'] }],
    [
      'hasflag',
      { requires: 'imap4flags', tags: match, args: ['string-list'], leadingList: true }
    ],
    [
      'spamtest',
      { requires: 'spamtest', tags: [{ name: 'percent', arg: 'none', requires: 'spamtestplus' }], args: ['string'] }
    ],
    ['virustest', { requires: 'virustest', args: ['string'] }],
    ['environment', { requires: 'environment', tags: match, args: ['string', 'string-list'] }],
    [
      'date',
      {
        requires: 'date',
        tags: tags(zoneTags, match, indexTags),
        args: ['string', 'string', 'string-list']
      }
    ],
    [
      'currentdate',
      {
        requires: 'date',
        tags: tags([{ name: 'zone', arg: 'zone', group: 'zone' }], match),
        args: ['string', 'string-list']
      }
    ],
    [
      'duplicate',
      {
        requires: 'duplicate',
        tags: [
          { name: 'handle', arg: 'string' },
          { name: 'header', arg: 'string', group: 'unique' },
          { name: 'uniqueid', arg: 'string', group: 'unique' },
          { name: 'seconds', arg: 'number' },
          { name: 'last', arg: 'none' }
        ],
        args: []
      }
    ],
    ['mailboxexists', { requires: 'mailbox', args: ['string-list'] }],
    [
      'metadata',
      { requires: 'mboxmetadata', tags: match, args: ['string', 'string', 'string-list'] }
    ],
    ['metadataexists', { requires: 'mboxmetadata', args: ['string', 'string-list'] }],
    ['servermetadata', { requires: 'servermetadata', tags: match, args: ['string', 'string-list'] }],
    ['servermetadataexists', { requires: 'servermetadata', args: ['string-list'] }],
    ['valid_notify_method', { requires: 'enotify', args: ['string-list'] }],
    [
      'notify_method_capability',
      { requires: 'enotify', tags: match, args: ['string', 'string', 'string-list'] }
    ],
    ['valid_ext_list', { requires: 'extlists', args: ['string-list'] }],
    [
      'specialuse_exists',
      { requires: 'special-use', args: ['string-list'], leadingString: true }
    ],
    ['mailboxidexists', { requires: 'mailboxid', args: ['string-list'] }],
    ['jmapquery', { requires: 'vnd.cyrus.jmapquery', args: ['string'] }],
    ['ihave', { requires: 'ihave', args: ['string-list'] }],
    ['convert', { requires: 'convert', args: ['string', 'string', 'string-list'] }],
    [
      'filter',
      { requires: 'vnd.dovecot.filter', args: ['string', 'string-list'], optionalArgs: 1 }
    ],
    [
      'execute',
      {
        requires: 'vnd.dovecot.execute',
        tags: [
          { name: 'input', arg: 'string', group: 'input' },
          { name: 'pipe', arg: 'none', group: 'input' },
          { name: 'output', arg: 'string', requires: 'variables' }
        ],
        args: ['string', 'string-list'],
        optionalArgs: 1
      }
    ]
  ])
  return map
}

const ACTIONS = actions()
const TESTS = tests()

/**
 * Parse a Sieve script and report language errors.
 * Covers RFC 5228 plus the extensions Cyrus and common ManageSieve servers accept.
 */
export function findSyntaxIssues(source: string, options?: SyntaxCheckOptions): CheckDiagnostic[] {
  const issues: CheckDiagnostic[] = []
  const seen = new Set<string>()
  const add = (line: number, message: string, syntax?: string): void => {
    if (issues.length >= MAX_ISSUES) return
    const key = `${line}\0${message}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(syntax ? { line, message, severity: 'error', syntax } : { line, message, severity: 'error' })
  }

  const tokens = tokenize(source, add)
  parse(tokens, add, options?.capabilities ?? null)
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return issues
}

function tokenize(source: string, add: (line: number, message: string) => void): Tok[] {
  const tokens: Tok[] = []
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0
  let line = 1

  const push = (kind: Tok['kind'], start: number, startLine: number, text: string): void => {
    tokens.push({ kind, i: start, line: startLine, text })
  }

  while (i < source.length) {
    const c = source[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const startLine = line
      i += 2
      let closed = false
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2
          closed = true
          break
        }
        if (source[i] === '\n') line++
        i++
      }
      if (!closed) add(startLine, 'Unclosed block comment')
      continue
    }
    if (c === '"') {
      const start = i
      const startLine = line
      i++
      let value = ''
      let closed = false
      while (i < source.length) {
        const ch = source[i]
        if (ch === '\n' || ch === '\r') break
        if (ch === '\\') {
          const n = source[i + 1]
          if (!n || n === '\n' || n === '\r') break
          if (n !== '\\' && n !== '"') add(startLine, 'Undefined escape in string')
          value += n
          i += 2
          continue
        }
        if (ch === '"') {
          i++
          closed = true
          break
        }
        value += ch
        i++
      }
      if (!closed) add(startLine, 'Unclosed string')
      push('string', start, startLine, value)
      continue
    }
    if (c >= '0' && c <= '9') {
      const start = i
      const startLine = line
      i++
      while (i < source.length && source[i] >= '0' && source[i] <= '9') i++
      if (/[KkMmGg]/.test(source[i] ?? '') && !IDENT_CONT.test(source[i + 1] ?? '')) i++
      push('number', start, startLine, source.slice(start, i))
      continue
    }
    if (IDENT_START.test(c)) {
      const start = i
      const startLine = line
      i++
      while (i < source.length && IDENT_CONT.test(source[i])) i++
      const text = source.slice(start, i)
      if (text.toLowerCase() === 'text' && source[i] === ':') {
        i++
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++
        if (source[i] === '\r') i++
        if (source[i] === '\n') {
          line++
          i++
        }
        let value = ''
        let closed = false
        while (i < source.length) {
          const lineStart = i
          while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++
          const content = source.slice(lineStart, i)
          const nl = source[i] === '\r' || source[i] === '\n'
          if (source[i] === '\r') i++
          if (source[i] === '\n') {
            line++
            i++
          }
          if (content === '.') {
            closed = true
            break
          }
          value += content.startsWith('..') ? content.slice(1) : content
          if (nl) value += '\n'
        }
        if (!closed) add(startLine, 'Unclosed multiline string')
        push('string', start, startLine, value)
        continue
      }
      push('ident', start, startLine, text)
      continue
    }
    if (c === ':' && IDENT_START.test(source[i + 1] ?? '')) {
      const start = i
      const startLine = line
      i++
      const id = i
      i++
      while (i < source.length && IDENT_CONT.test(source[i])) i++
      push('tag', start, startLine, source.slice(id, i).toLowerCase())
      continue
    }
    if ('[](){},;'.includes(c)) {
      push('punct', i, line, c)
      i++
      continue
    }
    add(line, `Unexpected character "${showChar(c)}"`)
    i++
  }

  tokens.push({ kind: 'eof', i: source.length, line, text: '' })
  return tokens
}

function showChar(c: string): string {
  const code = c.charCodeAt(0)
  if (code < 32 || code === 127) return `\\u${code.toString(16).padStart(4, '0')}`
  return c
}

function parse(
  tokens: Tok[],
  addLine: (line: number, message: string, syntax?: string) => void,
  capabilities: readonly string[] | null
): void {
  let p = 0
  let seenOther = false
  const enabledSets: Array<Set<string>> = [new Set()]
  const server = capabilities ? new Set(capabilities.map((c) => c.toLowerCase())) : null
  const eof = tokens[tokens.length - 1]

  const add = (tok: Tok, message: string, syntax?: string): void => addLine(tok.line, message, syntax)
  const peek = (n = 0): Tok => tokens[p + n] ?? eof
  const bump = (): Tok => {
    const t = peek()
    if (t.kind !== 'eof') p++
    return t
  }
  const punct = (text: string, n = 0): boolean => {
    const t = peek(n)
    return t.kind === 'punct' && t.text === text
  }
  const isTag = (t: Tok): boolean => t.kind === 'tag'
  const isListStart = (t: Tok): boolean => t.kind === 'string' || (t.kind === 'punct' && t.text === '[')

  function hasRaw(name: string): boolean {
    return enabledSets.some((s) => s.has(name))
  }

  function hasCap(name: string): boolean {
    const n = name.toLowerCase()
    if (hasRaw(n)) return true
    for (const group of EQUIV) {
      if (group.includes(n) && group.some((c) => hasRaw(c))) return true
    }
    if (n === 'spamtest' && hasRaw('spamtestplus')) return true
    return false
  }

  function serverHas(name: string): boolean {
    if (!server) return true
    const n = name.toLowerCase()
    if (ALWAYS.has(n) || server.has(n)) return true
    for (const group of EQUIV) {
      if (group.includes(n) && group.some((c) => server.has(c))) return true
    }
    if (n === 'spamtest' && server.has('spamtestplus')) return true
    return false
  }

  function needCaps(reqs: string | string[] | undefined, tok: Tok, what: string): void {
    if (!reqs) return
    const list = Array.isArray(reqs) ? reqs : [reqs]
    for (const req of list) {
      if (!hasCap(req)) add(tok, `${what} requires "${req}"`)
    }
  }

  function skipList(from: number): number {
    const t = tokens[from]
    if (!t || t.kind === 'eof') return -1
    if (t.kind === 'string') return from + 1
    if (t.kind === 'punct' && t.text === '[') {
      let i = from + 1
      let depth = 1
      while (i < tokens.length) {
        const c = tokens[i]
        if (c.kind === 'eof') return -1
        if (c.kind === 'punct' && c.text === '[') depth++
        else if (c.kind === 'punct' && c.text === ']') {
          depth--
          if (depth === 0) return i + 1
        }
        i++
      }
    }
    return -1
  }

  function parseString(): string | null {
    const t = peek()
    if (t.kind === 'punct' && t.text === '[') {
      add(t, 'Expected a string, found a list')
      return null
    }
    if (t.kind !== 'string') {
      add(t, 'Expected a string')
      return null
    }
    bump()
    return t.text
  }

  function parseStringList(): string[] | null {
    const t = peek()
    if (t.kind === 'string') {
      bump()
      return [t.text]
    }
    if (!(t.kind === 'punct' && t.text === '[')) {
      add(t, 'Expected a string list')
      return null
    }
    bump()
    const values: string[] = []
    if (punct(']')) {
      add(peek(), 'Empty string list')
      bump()
      return values
    }
    const takeString = (): boolean => {
      if (peek().kind === 'string') {
        values.push(bump().text)
        return true
      }
      add(peek(), 'Expected a string')
      return false
    }
    if (!takeString()) {
      while (!punct(']') && peek().kind !== 'eof') bump()
      if (punct(']')) bump()
      return null
    }
    while (!punct(']') && peek().kind !== 'eof') {
      if (punct(',')) {
        bump()
        if (punct(']')) {
          add(peek(), 'Trailing comma in string list')
          bump()
          return values
        }
        if (!takeString()) {
          while (!punct(']') && peek().kind !== 'eof') bump()
          if (punct(']')) bump()
          return null
        }
        continue
      }
      if (peek().kind === 'string') {
        add(peek(), 'Missing comma in string list')
        values.push(bump().text)
        continue
      }
      add(peek(), `Unexpected ${describe(peek())}`)
      while (!punct(']') && peek().kind !== 'eof') bump()
      if (punct(']')) bump()
      return null
    }
    if (punct(']')) {
      bump()
      return values
    }
    add(peek(), 'Missing "]"')
    return null
  }

  function parseNumber(): boolean {
    if (peek().kind !== 'number') {
      add(peek(), 'Expected a number')
      return false
    }
    bump()
    return true
  }

  function parseTagArg(def: TagDef): boolean {
    if (def.arg === 'none') return true
    if (def.arg === 'string-list') return parseStringList() !== null
    if (def.arg === 'number') return parseNumber()
    const tok = peek()
    const value = parseString()
    if (value === null) return false
    const folded = value.toLowerCase()
    if (def.arg === 'rel' && !REL.has(folded)) {
      add(tok, 'Relational match must be "gt", "ge", "lt", "le", "eq", or "ne"')
    } else if (def.arg === 'comparator') {
      if (!COMPARATORS.has(folded)) add(tok, `Unknown comparator "${value}"`)
      else if (folded === 'i;ascii-numeric') {
        needCaps('comparator-i;ascii-numeric', tok, 'Comparator "i;ascii-numeric"')
      } else if (folded === 'i;unicode-casemap') {
        needCaps('comparator-i;unicode-casemap', tok, 'Comparator "i;unicode-casemap"')
      }
    } else if (def.arg === 'importance' && value !== '1' && value !== '2' && value !== '3') {
      add(tok, 'Importance must be "1", "2", or "3"')
    } else if (def.arg === 'zone' && !/^[+-]\d{4}$/.test(value)) {
      add(tok, 'Time zone must be "+hhmm" or "-hhmm"')
    } else if (def.arg === 'ret' && folded !== 'full' && folded !== 'hdrs') {
      add(tok, ':ret must be "FULL" or "HDRS"')
    } else if (def.arg === 'bymode' && folded !== 'notify' && folded !== 'return') {
      add(tok, ':bymode must be "notify" or "return"')
    }
    return true
  }

  function startsKind(kind: ArgKind, t: Tok): boolean {
    if (kind === 'string') return t.kind === 'string'
    if (kind === 'number') return t.kind === 'number'
    if (kind === 'string-list' || kind === 'addresses') return isListStart(t)
    return false
  }

  function parsePositional(kind: ArgKind): boolean {
    if (kind === 'string') return parseString() !== null
    if (kind === 'string-list') return parseStringList() !== null
    if (kind === 'number') return parseNumber()
    if (peek().kind === 'punct' && peek().text === '[') {
      if (!hasCap('vnd.cyrus.redirect-multiple')) {
        add(peek(), 'Redirect address list requires "vnd.cyrus.redirect-multiple"')
      }
      return parseStringList() !== null
    }
    return parseString() !== null
  }

  function parseArguments(spec: WordSpec, where: Tok): boolean {
    const seenTag = new Set<string>()
    const seenGroup = new Set<string>()
    while (isTag(peek())) {
      const tok = peek()
      const def = spec.tags?.find((item) => item.name === tok.text)
      if (!def) {
        add(tok, `Unknown tagged argument ":${tok.text}"`)
        return false
      }
      bump()
      if (def.group) {
        if (seenGroup.has(def.group)) {
          add(
            tok,
            def.group === 'size'
              ? 'Only one of ":over" and ":under" is allowed'
              : `Duplicate ${groupLabel(def.group)} ":${def.name}"`
          )
        }
        seenGroup.add(def.group)
      } else if (seenTag.has(def.name)) {
        add(tok, `Duplicate tagged argument ":${def.name}"`)
      }
      seenTag.add(def.name)
      needCaps(def.requires, tok, `Tag ":${def.name}"`)
      if (!parseTagArg(def)) return false
    }
    for (const group of spec.requireGroups ?? []) {
      if (!seenGroup.has(group)) add(where, 'Expected ":over" or ":under"')
    }
    for (const def of spec.tags ?? []) {
      if (def.with && seenTag.has(def.name) && !seenTag.has(def.with)) {
        add(where, `":${def.name}" requires ":${def.with}"`)
      }
    }
    for (const name of spec.requireTags ?? []) {
      if (!seenTag.has(name)) add(where, `Missing tagged argument ":${name}"`)
    }
    if (spec.leadingString && peek().kind === 'string' && isListStart(peek(1))) bump()
    if (spec.leadingList && isListStart(peek())) {
      const after = skipList(p)
      if (after >= 0 && isListStart(tokens[after] ?? eof)) {
        if (!hasCap('variables')) add(peek(), 'Variable list requires "variables"')
        if (!parseStringList()) return false
      }
    }
    const optional = spec.optionalArgs ?? 0
    const requiredCount = spec.args.length - optional
    for (let i = 0; i < spec.args.length; i++) {
      const kind = spec.args[i]
      if (i >= requiredCount && !startsKind(kind, peek())) break
      if (!parsePositional(kind)) return false
    }
    if (isTag(peek())) {
      add(peek(), `Tagged argument ":${peek().text}" must come before positional arguments`)
      return false
    }
    if (
      peek().kind === 'string' ||
      peek().kind === 'number' ||
      punct('[') ||
      punct('(')
    ) {
      add(peek(), 'Unexpected argument')
      return false
    }
    return true
  }

  function recover(mode: 'command' | 'test'): void {
    let depth = 0
    while (peek().kind !== 'eof') {
      const t = peek()
      if (t.kind === 'punct' && (t.text === '{' || t.text === '(' || t.text === '[')) {
        if (mode === 'test' && depth === 0 && t.text === '{') return
        depth++
        bump()
        continue
      }
      if (t.kind === 'punct' && (t.text === '}' || t.text === ')' || t.text === ']')) {
        if (depth === 0) return
        depth--
        bump()
        continue
      }
      if (depth === 0 && punct(';')) {
        if (mode === 'command') bump()
        return
      }
      if (mode === 'test' && depth === 0 && (punct(',') || punct(')'))) return
      if (mode === 'command' && depth === 0 && t.kind === 'ident') return
      bump()
    }
  }

  function parseTest(): boolean {
    if (peek().kind === 'ident' && peek().text.toLowerCase() === 'not') {
      bump()
      return parseTest()
    }
    const t = peek()
    if (t.kind !== 'ident') {
      add(t, 'Expected a test')
      return false
    }
    bump()
    const name = t.text.toLowerCase()
    if (name === 'allof' || name === 'anyof') return parseTestList(t)
    if (name === 'true' || name === 'false') return true
    const spec = TESTS.get(name)
    if (!spec) {
      if (CONTROL_WORDS.has(name) || (ACTIONS.has(name) && !TESTS.has(name))) {
        add(t, `"${t.text}" is a command and cannot be used as a test`)
      } else add(t, `Unknown test "${t.text}"`)
      return false
    }
    needCaps(spec.requires, t, `Test "${t.text}"`)
    return parseArguments(spec, t)
  }

  function parseTestList(word: Tok): boolean {
    const name = word.text
    const syntax = `${name.toLowerCase()} (test [, test]...)`
    if (!punct('(')) {
      add(word, `Expected "(" after "${name}"`, syntax)
      return false
    }
    bump()
    if (punct(')')) {
      add(word, `Expected a test in "${name}"`, syntax)
      bump()
      return true
    }
    if (!parseTest()) recover('test')
    while (peek().kind !== 'eof') {
      if (punct(')')) {
        bump()
        return true
      }
      if (punct('{') || punct('}')) {
        add(word, `Missing ")" for "${name}"`, syntax)
        return false
      }
      if (punct(',')) {
        bump()
        if (punct(')')) {
          add(word, `Trailing comma in "${name}"`, syntax)
          bump()
          return true
        }
        if (!parseTest()) recover('test')
        continue
      }
      if (peek().kind === 'ident') {
        add(peek(), `Missing comma in "${name}"`, syntax)
        if (!parseTest()) recover('test')
        continue
      }
      add(peek(), `Unexpected ${describe(peek())} in "${name}"`, syntax)
      return false
    }
    add(word, `Missing ")" for "${name}"`, syntax)
    return false
  }

  function consumeBlock(): boolean {
    if (!punct('{')) {
      add(peek(), 'Expected "{"')
      return false
    }
    bump()
    parseCommands(true)
    if (punct('}')) {
      bump()
      return true
    }
    add(peek(), 'Missing "}"')
    return false
  }

  function expectSemi(name: string): void {
    if (punct(';')) {
      bump()
      return
    }
    add(peek(), `Missing semicolon after "${name}"`)
  }

  function parseRequire(cmd: Tok): void {
    if (seenOther) add(cmd, '"require" must come before any other command')
    const caps = parseStringList()
    if (!caps) {
      recover('command')
      return
    }
    for (const cap of caps) {
      enabledSets[0].add(cap.toLowerCase())
      if (!serverHas(cap)) add(cmd, `Capability "${cap}" is not supported by this server`)
    }
    expectSemi('require')
  }

  function parseIhave(cmd: Tok): void {
    needCaps('ihave', cmd, 'Command "ihave"')
    const caps = parseStringList()
    if (!caps) {
      recover('command')
      return
    }
    if (!punct('{')) {
      add(peek(), 'Expected "{"')
      recover('command')
      return
    }
    bump()
    enabledSets.push(new Set(caps.map((c) => c.toLowerCase())))
    parseCommands(true)
    enabledSets.pop()
    if (punct('}')) bump()
    else add(peek(), 'Missing "}"')
  }

  function parseBranch(kind: 'if' | 'elsif' | 'else'): void {
    if (kind !== 'else' && !parseTest()) recover('test')
    if (!consumeBlock()) recover('command')
  }

  function parseCommand(): 'require' | 'if' | 'elsif' | 'other' {
    const cmd = bump()
    const name = cmd.text.toLowerCase()
    const raw = cmd.text
    if (name === 'require') {
      parseRequire(cmd)
      return 'require'
    }
    seenOther = true
    if (name === 'if' || name === 'elsif') {
      parseBranch(name)
      return name
    }
    if (name === 'else') {
      parseBranch('else')
      return 'other'
    }
    if (name === 'ihave') {
      parseIhave(cmd)
      return 'other'
    }
    const spec = ACTIONS.get(name)
    if (!spec) {
      if (TESTS.has(name) || TEST_WORDS.has(name)) {
        add(cmd, `"${raw}" is a test and cannot be used as a command`)
      } else add(cmd, `Unknown command "${raw}"`)
      recover('command')
      return 'other'
    }
    needCaps(spec.requires, cmd, `Command "${raw}"`)
    if (!parseArguments(spec, cmd)) {
      recover('command')
      return 'other'
    }
    if (spec.block) {
      if (!consumeBlock()) recover('command')
      return 'other'
    }
    if (punct(';')) {
      bump()
      return 'other'
    }
    if (punct('{')) {
      add(peek(), `"${raw}" does not take a block`)
      consumeBlock()
      return 'other'
    }
    add(peek(), `Missing semicolon after "${raw}"`)
    return 'other'
  }

  function parseCommands(inBlock: boolean): void {
    let afterIf = false
    while (peek().kind !== 'eof') {
      if (inBlock && punct('}')) return
      if (punct('}')) {
        add(peek(), 'Unexpected "}"')
        bump()
        afterIf = false
        seenOther = true
        continue
      }
      if (peek().kind !== 'ident') {
        add(peek(), `Unexpected ${describe(peek())}`)
        recover('command')
        afterIf = false
        seenOther = true
        continue
      }
      const name = peek().text.toLowerCase()
      if ((name === 'elsif' || name === 'else') && !afterIf) {
        add(peek(), `"${peek().text}" must follow "if" or "elsif"`)
      }
      const kind = parseCommand()
      afterIf = kind === 'if' || kind === 'elsif'
    }
    if (inBlock) add(peek(), 'Missing "}"')
  }

  parseCommands(false)
}

function describe(t: Tok): string {
  if (t.kind === 'string') return 'string'
  if (t.kind === 'number') return 'number'
  if (t.kind === 'ident') return `"${t.text}"`
  if (t.kind === 'tag') return `":${t.text}"`
  if (t.kind === 'punct') return `"${t.text}"`
  return 'end of script'
}

function groupLabel(group: string): string {
  switch (group) {
    case 'match':
      return 'match type'
    case 'addr':
      return 'address part'
    case 'comparator':
      return 'comparator'
    case 'body':
      return 'body transform'
    case 'zone':
      return 'time zone'
    case 'mimeopt':
      return 'MIME option'
    case 'bytime':
      return 'by-time'
    case 'unique':
      return 'duplicate id'
    case 'location':
      return 'location'
    case 'mod40':
    case 'mod30':
      return 'case modifier'
    case 'mod20':
      return 'quote modifier'
    case 'input':
      return 'input'
    default:
      return 'tagged argument'
  }
}
