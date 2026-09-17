import { sieve } from '@codemirror/legacy-modes/mode/sieve'
import type { StreamParser, StringStream } from '@codemirror/language'

type TokenFn = (stream: StringStream, state: IndentState) => string | null

type IndentState = {
  tokenize?: TokenFn | null
  baseIndent?: number
  _indent: string[]
  _multiLineString?: boolean
}

const defaultTokenize = (sieve.startState!(0) as IndentState).tokenize

/** Legacy sieve mode only tracks `{` / `(`. Also indent `[` the same way. */
export const sieveMode: StreamParser<IndentState> = {
  name: sieve.name,
  startState(base) {
    return sieve.startState!(base) as IndentState
  },
  copyState(state) {
    return {
      tokenize: state.tokenize,
      baseIndent: state.baseIndent,
      _indent: state._indent.slice(),
      _multiLineString: state._multiLineString
    }
  },
  token(stream, state) {
    const inStringOrComment = Boolean(state.tokenize && state.tokenize !== defaultTokenize)
    if (inStringOrComment) return sieve.token!(stream, state)
    if (stream.eatSpace()) return null
    const ch = stream.peek()
    if (ch === '[') {
      stream.next()
      state._indent.push('[')
      return null
    }
    if (ch === ']') {
      stream.next()
      if (state._indent.at(-1) === '[') state._indent.pop()
      return null
    }
    return sieve.token!(stream, state)
  },
  indent(state, textAfter, cx) {
    let length = state._indent.length
    const first = textAfter.trimStart()[0]
    if (first === '}' || first === ']') length--
    if (length < 0) length = 0
    return length * cx.unit
  },
  languageData: {
    indentOnInput: /^\s*[}\]]$/
  }
}
