/** Re-indent Sieve source using the editor tab setting. Leaves text: and octet literals alone. */

export function formatSieve(
  source: string,
  opts: { indentWithTabs: boolean; tabSize: number }
): string {
  const width = Math.min(8, Math.max(1, opts.tabSize))
  const unit = opts.indentWithTabs ? '\t' : ' '.repeat(width)
  let i = 0
  let depth = 0
  let inString = false
  let inBlock = false
  let inText = false
  let octets = 0
  let out = ''

  const peek = (n = 0) => source[i + n]
  const emit = (ch: string) => {
    out += ch
  }

  while (i < source.length) {
    const lineStart = i === 0 || source[i - 1] === '\n'

    if (octets > 0) {
      emit(source[i])
      octets--
      i++
      continue
    }

    if (inText) {
      if (lineStart) {
        let end = i
        while (end < source.length && source[end] !== '\n') end++
        const line = source.slice(i, end).replace(/\r$/, '')
        out += source.slice(i, end)
        i = end
        if (source[i] === '\n') {
          emit('\n')
          i++
        }
        if (line === '.') inText = false
      } else {
        emit(source[i])
        i++
      }
      continue
    }

    if (lineStart && !inString && !inBlock && !inText) {
      while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
      const atBreak = i >= source.length || source[i] === '\n' || source[i] === '\r'
      if (!atBreak) {
        let j = i
        let close = 0
        while (j < source.length && (source[j] === '}' || source[j] === ']' || source[j] === ')')) {
          close++
          j++
          while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++
        }
        out += unit.repeat(Math.max(0, depth - close))
      }
    }

    const c = peek()
    if (c == null) break

    if (inString) {
      emit(c)
      i++
      if (c === '\\' && i < source.length) {
        emit(source[i])
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }

    if (inBlock) {
      emit(c)
      i++
      if (c === '*' && peek() === '/') {
        emit(source[i])
        i++
        inBlock = false
      }
      continue
    }

    if (c === '#') {
      while (i < source.length && source[i] !== '\n') {
        emit(source[i])
        i++
      }
      continue
    }

    if (c === '/' && peek(1) === '*') {
      emit(c)
      emit(source[i + 1])
      i += 2
      inBlock = true
      continue
    }

    if (c === '"') {
      emit(c)
      i++
      inString = true
      continue
    }

    if (c === '{') {
      const rest = source.slice(i)
      const lit = rest.match(/^\{(\d+)\+?\}/)
      if (lit) {
        out += lit[0]
        i += lit[0].length
        if (source[i] === '\r') {
          emit('\r')
          i++
        }
        if (source[i] === '\n') {
          emit('\n')
          i++
        }
        octets = Number(lit[1])
        continue
      }
      depth++
      emit(c)
      i++
      continue
    }

    if ((c === 't' || c === 'T') && !isIdentChar(peek(-1))) {
      const word = source.slice(i, i + 5)
      if (word.toLowerCase() === 'text:' ) {
        out += source.slice(i, i + 5)
        i += 5
        while (i < source.length && source[i] !== '\n') {
          emit(source[i])
          i++
        }
        if (source[i] === '\n') {
          emit('\n')
          i++
        }
        inText = true
        continue
      }
    }

    if (c === '[' || c === '(') depth++
    if (c === '}' || c === ']' || c === ')') depth = Math.max(0, depth - 1)
    emit(c)
    i++
  }

  return out
}

function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false
  return /[A-Za-z0-9_]/.test(ch)
}
