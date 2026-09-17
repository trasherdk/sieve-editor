<script lang="ts">
  import { onMount } from 'svelte'
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter
  } from '@codemirror/view'
  import { Compartment, EditorState } from '@codemirror/state'
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
  import {
    StreamLanguage,
    bracketMatching,
    foldGutter,
    indentOnInput,
    syntaxHighlighting,
    defaultHighlightStyle
  } from '@codemirror/language'
  import { sieve } from '@codemirror/legacy-modes/mode/sieve'
  import { autocompletion, closeBrackets, completeFromList } from '@codemirror/autocomplete'
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
  import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
  import { oneDark } from '@codemirror/theme-one-dark'
  import type { CheckDiagnostic } from '@shared/types'

  let {
    value = '',
    keywords = [],
    diagnostics = [],
    onchange
  }: {
    value?: string
    keywords?: string[]
    diagnostics?: CheckDiagnostic[]
    onchange: (next: string) => void
  } = $props()

  let parent: HTMLDivElement | undefined = $state()
  let view: EditorView | undefined = $state()
  let applying = false
  const lintConf = new Compartment()
  const autoConf = new Compartment()

  function toCmDiagnostics(doc: string, items: CheckDiagnostic[]): Diagnostic[] {
    const lines = doc.split('\n')
    return items.map((item) => {
      const lineNo = item.line && item.line > 0 ? item.line : 1
      let from = 0
      for (let i = 1; i < lineNo && i <= lines.length; i++) from += lines[i - 1].length + 1
      const line = lines[lineNo - 1] ?? ''
      return {
        from,
        to: from + Math.max(line.length, 1),
        severity: item.severity,
        message: item.message
      }
    })
  }

  function lintExt(items: CheckDiagnostic[]) {
    const snapshot = items
    return linter((v) => toCmDiagnostics(v.state.doc.toString(), snapshot))
  }

  function autoExt(words: string[]) {
    if (!words.length) return autocompletion()
    return autocompletion({
      override: [completeFromList(words.map((label) => ({ label, type: 'keyword' })))]
    })
  }

  onMount(() => {
    if (!parent) return
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          StreamLanguage.define(sieve),
          autoConf.of(autoExt(keywords)),
          lintGutter(),
          lintConf.of(lintExt(diagnostics)),
          oneDark,
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (applying) return
            if (update.docChanged) onchange(update.state.doc.toString())
          })
        ]
      })
    })
    return () => view?.destroy()
  })

  $effect(() => {
    if (!view) return
    view.dispatch({
      effects: [lintConf.reconfigure(lintExt(diagnostics)), autoConf.reconfigure(autoExt(keywords))]
    })
  })

  $effect(() => {
    if (!view) return
    const current = view.state.doc.toString()
    if (value !== current) {
      applying = true
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value }
      })
      applying = false
    }
  })
</script>

<div class="h-full min-h-0" bind:this={parent}></div>
