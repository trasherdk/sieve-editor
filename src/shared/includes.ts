import type { CheckDiagnostic, SieveScript } from './types'

export type IncludeLocation = 'personal' | 'global'

export type IncludeRef = {
  name: string
  location: IncludeLocation
  optional: boolean
  once: boolean
}

export type ScriptTreeKind = 'active' | 'personal' | 'global' | 'missing' | 'cycle'

export type ScriptTreeNode = {
  name: string
  kind: ScriptTreeKind
  children: ScriptTreeNode[]
}

export type ScriptTreeRow = {
  id: string
  name: string
  kind: ScriptTreeKind
  gutter: string
  openable: boolean
  spacer?: boolean
}

export type ScriptGraph = {
  root: ScriptTreeNode | null
  unused: string[]
}

const IDENT_START = /[A-Za-z_]/
const IDENT_CONT = /[A-Za-z0-9_]/
const INCLUDE_TAGS = new Set(['personal', 'global', 'once', 'optional'])

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

function skipHashComment(src: string, i: number): number {
  while (i < src.length && src[i] !== '\n') i++
  return i
}

function skipBlockComment(src: string, i: number): number {
  const end = src.indexOf('*/', i + 2)
  return end < 0 ? src.length : end + 2
}

function skipQuoted(src: string, i: number): { value: string; i: number } {
  let value = ''
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '"') return { value, i: i + 1 }
    if (c === '\\' && i + 1 < src.length) {
      value += src[i + 1]
      i += 2
      continue
    }
    value += c
    i++
  }
  return { value, i }
}

function skipLiteral(src: string, i: number): number {
  const m = src.slice(i).match(/^\{(\d+)\+?\}/)
  if (!m) return i + 1
  i += m[0].length
  if (src[i] === '\r') i++
  if (src[i] === '\n') i++
  return Math.min(src.length, i + Number(m[1]))
}

function skipMultiline(src: string, i: number): number {
  while (i < src.length && src[i] !== '\n') i++
  if (src[i] === '\n') i++
  while (i < src.length) {
    const lineStart = i
    while (i < src.length && src[i] !== '\n') i++
    const line = src.slice(lineStart, i).replace(/\r$/, '')
    if (src[i] === '\n') i++
    if (line === '.') return i
  }
  return i
}

function skipWsAndComments(src: string, i: number): number {
  while (i < src.length) {
    const c = src[i]
    if (isWs(c)) {
      i++
      continue
    }
    if (c === '#') {
      i = skipHashComment(src, i)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i = skipBlockComment(src, i)
      continue
    }
    break
  }
  return i
}

function readIdent(src: string, i: number): { ident: string; i: number } {
  const start = i
  i++
  while (i < src.length && IDENT_CONT.test(src[i])) i++
  return { ident: src.slice(start, i), i }
}

function parseIncludeArgs(src: string, i: number): { ref: IncludeRef; i: number } | null {
  i = skipWsAndComments(src, i)
  let location: IncludeLocation = 'personal'
  let optional = false
  let once = false
  while (i < src.length && src[i] === ':') {
    i++
    const tag = readIdent(src, i)
    if (!INCLUDE_TAGS.has(tag.ident.toLowerCase())) return null
    i = skipWsAndComments(src, tag.i)
    const t = tag.ident.toLowerCase()
    if (t === 'global' || t === 'personal') location = t
    else if (t === 'optional') optional = true
    else if (t === 'once') once = true
  }
  i = skipWsAndComments(src, i)
  if (src[i] !== '"') return null
  const q = skipQuoted(src, i)
  if (!q.value) return null
  return { ref: { name: q.value, location, optional, once }, i: q.i }
}

function lineOf(source: string, index: number): number {
  let n = 1
  for (let k = 0; k < index && k < source.length; k++) if (source[k] === '\n') n++
  return n
}

/** Unclosed strings and unmatched [] () {} outside comments/strings. */
export function findSyntaxIssues(source: string): CheckDiagnostic[] {
  const issues: CheckDiagnostic[] = []
  const stack: Array<{ ch: string; i: number }> = []
  const closeOf: Record<string, string> = { '[': ']', '(': ')', '{': '}' }
  const openOf: Record<string, string> = { ']': '[', ')': '(', '}': '{' }
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '#') {
      i = skipHashComment(source, i)
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    if (c === '"') {
      const start = i
      let j = i + 1
      let closed = false
      while (j < source.length) {
        if (source[j] === '\\' && j + 1 < source.length) {
          j += 2
          continue
        }
        if (source[j] === '"') {
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) {
        issues.push({ line: lineOf(source, start), message: 'Unclosed string', severity: 'error' })
        return issues
      }
      i = j
      continue
    }
    if (c === '{') {
      if (/^\{\d+\+?\}/.test(source.slice(i))) {
        i = skipLiteral(source, i)
        continue
      }
      stack.push({ ch: '{', i })
      i++
      continue
    }
    if (c === '[' || c === '(') {
      stack.push({ ch: c, i })
      i++
      continue
    }
    if (c === ']' || c === ')' || c === '}') {
      const top = stack.pop()
      if (!top || top.ch !== openOf[c]) {
        issues.push({ line: lineOf(source, i), message: `Unmatched ${c}`, severity: 'error' })
      }
      i++
      continue
    }
    if (IDENT_START.test(c)) {
      const w = readIdent(source, i)
      if (w.ident.toLowerCase() === 'text') {
        const j = skipWsAndComments(source, w.i)
        if (source[j] === ':') {
          i = skipMultiline(source, j + 1)
          continue
        }
      }
      i = w.i
      continue
    }
    i++
  }
  for (const open of stack) {
    issues.push({
      line: lineOf(source, open.i),
      message: `Missing closing ${closeOf[open.ch]}`,
      severity: 'error'
    })
  }
  return issues
}

/** Collect RFC 6609 include actions; skip comments, strings, and text: bodies. */
export function parseIncludes(source: string): IncludeRef[] {
  const out: IncludeRef[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '#') {
      i = skipHashComment(source, i)
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    if (c === '"') {
      i = skipQuoted(source, i).i
      continue
    }
    if (c === '{') {
      i = skipLiteral(source, i)
      continue
    }
    if (IDENT_START.test(c)) {
      const w = readIdent(source, i)
      if (w.ident.toLowerCase() === 'text') {
        const j = skipWsAndComments(source, w.i)
        if (source[j] === ':') {
          i = skipMultiline(source, j + 1)
          continue
        }
      }
      if (w.ident.toLowerCase() === 'include') {
        const parsed = parseIncludeArgs(source, w.i)
        if (parsed) {
          out.push(parsed.ref)
          i = parsed.i
          continue
        }
      }
      i = w.i
      continue
    }
    i++
  }
  return out
}

function personalNames(scripts: SieveScript[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of scripts) {
    map.set(s.name, s.name)
    const lower = s.name.toLowerCase()
    if (!map.has(lower)) map.set(lower, s.name)
  }
  return map
}

function resolvePersonal(names: Map<string, string>, want: string): string | null {
  return names.get(want) ?? names.get(want.toLowerCase()) ?? null
}

function walk(
  name: string,
  kind: ScriptTreeKind,
  bodies: Record<string, string>,
  names: Map<string, string>,
  stack: Set<string>,
  used: Set<string>
): ScriptTreeNode {
  if (kind === 'personal' || kind === 'active') used.add(name)
  if (kind === 'global' || kind === 'missing' || kind === 'cycle') {
    return { name, kind, children: [] }
  }
  const children: ScriptTreeNode[] = []
  const nextStack = new Set(stack)
  nextStack.add(name)
  for (const inc of parseIncludes(bodies[name] ?? '')) {
    if (inc.location === 'global') {
      children.push({ name: inc.name, kind: 'global', children: [] })
      continue
    }
    const resolved = resolvePersonal(names, inc.name)
    if (!resolved) {
      children.push({ name: inc.name, kind: 'missing', children: [] })
      continue
    }
    if (nextStack.has(resolved)) {
      children.push({ name: resolved, kind: 'cycle', children: [] })
      continue
    }
    const childKind: ScriptTreeKind = 'personal'
    children.push(walk(resolved, childKind, bodies, names, nextStack, used))
  }
  return { name, kind, children }
}

export function buildScriptGraph(scripts: SieveScript[], bodies: Record<string, string>): ScriptGraph {
  const names = personalNames(scripts)
  const active = scripts.find((s) => s.active)
  if (!active) {
    const unused = [...scripts]
      .map((s) => s.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    return { root: null, unused }
  }
  const used = new Set<string>()
  const root = walk(active.name, 'active', bodies, names, new Set(), used)
  const unused = scripts
    .map((s) => s.name)
    .filter((n) => !used.has(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return { root, unused }
}

export function flattenTree(root: ScriptTreeNode): ScriptTreeRow[] {
  const rows: ScriptTreeRow[] = []
  function visit(node: ScriptTreeNode, prefix: string, isLast: boolean, isRoot: boolean, path: string): void {
    const branch = isRoot ? '' : isLast ? '└ ' : '├ '
    const kind = node.kind
    if (!isRoot) {
      rows.push({
        id: `${path}/${rows.length}:spacer`,
        name: '',
        kind,
        gutter: `${prefix}│`,
        openable: false,
        spacer: true
      })
    }
    rows.push({
      id: `${path}/${rows.length}:${node.name}:${kind}`,
      name: node.name,
      kind,
      gutter: prefix + branch,
      openable: kind === 'active' || kind === 'personal' || kind === 'cycle'
    })
    const childPrefix = isRoot ? '' : isLast ? '  ' : '│ '
    node.children.forEach((child, i) => {
      visit(child, prefix + childPrefix, i === node.children.length - 1, false, `${path}/${node.name}`)
    })
  }
  visit(root, '', true, true, '')
  return rows
}
