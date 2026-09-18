<script lang="ts">
  import { onMount } from 'svelte'
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection
  } from '@codemirror/view'
  import { Compartment, EditorState } from '@codemirror/state'
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
  import {
    StreamLanguage,
    bracketMatching,
    foldGutter,
    indentOnInput,
    indentUnit,
    syntaxHighlighting,
    defaultHighlightStyle
  } from '@codemirror/language'
  import { autocompletion, closeBrackets, completeFromList } from '@codemirror/autocomplete'
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
  import { linter, lintGutter, forceLinting, type Diagnostic } from '@codemirror/lint'
  import { oneDark } from '@codemirror/theme-one-dark'
  import type { CheckDiagnostic } from '@shared/types'
  import { sieveMode } from './sieveMode'

  let {
    value = '',
    keywords = [],
    diagnostics = [],
    indentWithTabs = true,
    tabSize = 4,
    onchange
  }: {
    value?: string
    keywords?: string[]
    diagnostics?: CheckDiagnostic[]
    indentWithTabs?: boolean
    tabSize?: number
    onchange: (next: string) => void
  } = $props()

  let parent: HTMLDivElement | undefined = $state()
  let view: EditorView | undefined = $state()
  let applying = false
  const lintConf = new Compartment()
  const autoConf = new Compartment()
  const indentConf = new Compartment()

  function indentExt(useTabs: boolean, size: number) {
    const width = Math.min(8, Math.max(1, size))
    const unit = useTabs ? '\t' : ' '.repeat(width)
    return [indentUnit.of(unit), EditorState.tabSize.of(width)]
  }

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
    return linter((v) => toCmDiagnostics(v.state.doc.toString(), snapshot), { delay: 0 })
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
          drawSelection({ cursorBlinkRate: 1200 }),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          StreamLanguage.define(sieveMode),
          autoConf.of(autoExt(keywords)),
          lintGutter(),
          lintConf.of(lintExt(diagnostics)),
          indentConf.of(indentExt(indentWithTabs, tabSize)),
          oneDark,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => true },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab
          ]),
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
      effects: [
        lintConf.reconfigure(lintExt(diagnostics)),
        autoConf.reconfigure(autoExt(keywords)),
        indentConf.reconfigure(indentExt(indentWithTabs, tabSize))
      ]
    })
    forceLinting(view)
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
