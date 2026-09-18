<script lang="ts">
  import { onMount } from 'svelte'
  import Login from './Login.svelte'
  import SieveEditor from './SieveEditor.svelte'
  import ScriptTree from './ScriptTree.svelte'
  import ScriptTabs from './ScriptTabs.svelte'
  import NamePrompt from './NamePrompt.svelte'
  import DirtyClosePrompt from './DirtyClosePrompt.svelte'
  import { buildScriptGraph, findSyntaxIssues, flattenTree } from '@shared/includes'
  import type {
    AccountInput,
    AccountRecord,
    Capabilities,
    CheckDiagnostic,
    ConnectResult,
    EditorPrefs,
    ScriptBodies,
    SieveScript
  } from '@shared/types'
  import { DEFAULT_INDENT_WITH_TABS, DEFAULT_TAB_SIZE, sanitizeScriptName } from '@shared/types'
  import { formatSieve } from '@shared/format'
  import { APP_NAME } from '@shared/app'
  import icon from './assets/icon.png'

  type EditorTab = {
    id: string
    name: string | null
    draftName: string
    body: string
    original: string
    diagnostics: CheckDiagnostic[]
  }

  const NEW_BODY = 'require ["fileinto"];\n\n'

  let appName = $state(APP_NAME)
  let appVersion = $state('')

  let accounts = $state<AccountRecord[]>([])
  let busy = $state(false)
  let saving = $state(false)
  let error = $state('')
  let connected = $state(false)
  let account = $state<AccountRecord | null>(null)
  let capabilities = $state<Capabilities | null>(null)
  let scripts = $state<SieveScript[]>([])
  let bodies = $state<ScriptBodies>({})
  let tabs = $state<EditorTab[]>([])
  let activeId = $state<string | null>(null)
  let status = $state('')
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let checkSeq = 0
  let draftSeq = 0
  let indentWithTabs = $state(DEFAULT_INDENT_WITH_TABS)
  let tabSize = $state(DEFAULT_TAB_SIZE)
  let lastInput = $state.raw<AccountInput | null>(null)
  let actionsMenu = $state(false)
  let naming = $state<{ title: string; value: string; confirmLabel: string } | null>(null)
  let namingDone: ((value: string | null) => void) | null = null
  let dirtyCloseId = $state<string | null>(null)
  let disconnectAsk = $state(false)

  const tab = $derived(tabs.find((t) => t.id === activeId) ?? null)
  const currentName = $derived(tab?.name ?? null)
  const dirty = $derived(Boolean(tab && tab.body !== tab.original))
  const anyDirty = $derived(tabs.some((t) => t.body !== t.original))
  const keywords = $derived(capabilities?.sieve ?? [])
  const hasErrors = $derived(Boolean(tab?.diagnostics.some((d) => d.severity === 'error')))
  const currentIsActive = $derived(
    Boolean(currentName && scripts.some((s) => s.name === currentName && s.active))
  )
  const graph = $derived.by(() => {
    const next = { ...bodies }
    for (const t of tabs) {
      if (t.name) next[t.name] = t.body
    }
    return buildScriptGraph(scripts, next)
  })
  const treeRows = $derived(graph.root ? flattenTree(graph.root) : [])
  const tabInfos = $derived(
    tabs.map((t) => ({
      id: t.id,
      label: t.draftName || t.name || 'untitled',
      dirty: t.body !== t.original,
      active: t.id === activeId
    }))
  )

  function namedTabId(name: string): string {
    return `s:${name}`
  }

  function currentTab(): EditorTab | undefined {
    return tabs.find((t) => t.id === activeId)
  }

  function findTabByName(name: string): EditorTab | undefined {
    return tabs.find((t) => t.name === name || t.id === namedTabId(name))
  }

  function persistOpenTabs(): void {
    if (!account) return
    const names = tabs.map((t) => t.name).filter((n): n is string => Boolean(n))
    const active = currentTab()?.name ?? null
    void window.api.accounts.setOpenTabs(account.id, { names, active }).catch(() => undefined)
  }

  function restoreTabs(acc: AccountRecord): void {
    const have = new Set(scripts.map((s) => s.name))
    let names = [...new Set((acc.openTabs?.names ?? []).filter((n) => have.has(n)))]
    if (!names.length && acc.lastScript && have.has(acc.lastScript)) names = [acc.lastScript]
    if (!names.length) {
      const fallback = scripts.find((s) => s.active)?.name || scripts[0]?.name
      if (fallback) names = [fallback]
    }
    tabs = names.map((name) => ({
      id: namedTabId(name),
      name,
      draftName: name,
      body: bodies[name] ?? '',
      original: bodies[name] ?? '',
      diagnostics: []
    }))
    const preferred =
      (acc.openTabs?.active && names.includes(acc.openTabs.active) && acc.openTabs.active) ||
      names[names.length - 1] ||
      null
    activeId = preferred ? namedTabId(preferred) : null
    const live = currentTab()
    if (live) scheduleCheck(live.body)
  }

  async function loadAccounts(): Promise<void> {
    const info = await window.api.app.info()
    appName = info.name
    appVersion = info.version
    document.title = info.title
    accounts = await window.api.accounts.list()
    const prefs = await window.api.prefs.get()
    indentWithTabs = prefs.indentWithTabs
    tabSize = prefs.tabSize
  }

  async function savePrefs(next: EditorPrefs): Promise<void> {
    const saved = await window.api.prefs.save(next)
    indentWithTabs = saved.indentWithTabs
    tabSize = saved.tabSize
  }

  async function loadBodies(list: SieveScript[]): Promise<ScriptBodies> {
    const next: ScriptBodies = {}
    for (const script of list) {
      try {
        next[script.name] = await window.api.sieve.get(script.name)
      } catch {
        next[script.name] = ''
      }
    }
    return next
  }

  async function applySnapshot(scriptsNext: SieveScript[], bodiesNext?: ScriptBodies): Promise<void> {
    scripts = scriptsNext
    bodies =
      bodiesNext && Object.keys(bodiesNext).length ? bodiesNext : await loadBodies(scriptsNext)
  }

  function cloneAccount(input: AccountInput): AccountInput {
    const snap = $state.snapshot(input)
    const out: AccountInput = {
      host: snap.host,
      port: snap.port,
      username: snap.username,
      tlsMode: snap.tlsMode,
      rejectUnauthorized: snap.rejectUnauthorized
    }
    if (snap.id != null) out.id = snap.id
    if (snap.password) out.password = snap.password
    if (snap.rememberPassword != null) out.rememberPassword = snap.rememberPassword
    return out
  }

  async function connect(input: AccountInput, resume = false): Promise<void> {
    busy = true
    error = ''
    try {
      const payload = cloneAccount(input)
      const result: ConnectResult = await window.api.sieve.connect(payload)
      lastInput = { ...payload, id: result.account.id }
      account = result.account
      capabilities = result.capabilities
      await applySnapshot(result.scripts, result.bodies)
      connected = true
      status = 'Connected'
      if (!resume) {
        tabs = []
        activeId = null
        restoreTabs(account)
        persistOpenTabs()
      }
      await loadAccounts()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      if (resume) connected = false
    } finally {
      busy = false
    }
  }

  function markDisconnected(reason: string): void {
    if (!account) return
    connected = false
    error = reason
    status = reason
  }

  function lost(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    if (/not connected|connection lost|idle timeout|econnreset|epipe|socket timeout/i.test(message)) {
      markDisconnected('Connection lost')
      return true
    }
    return false
  }

  async function reconnect(): Promise<void> {
    if (!lastInput) return
    await connect(lastInput, true)
  }

  async function openScript(name: string): Promise<void> {
    const existing = findTabByName(name)
    if (existing) {
      activeId = existing.id
      status = ''
      error = ''
      persistOpenTabs()
      return
    }
    if (!connected) {
      error = 'Not connected'
      return
    }
    busy = true
    error = ''
    try {
      const body = await window.api.sieve.get(name)
      const next: EditorTab = {
        id: namedTabId(name),
        name,
        draftName: name,
        body,
        original: body,
        diagnostics: []
      }
      tabs.push(next)
      activeId = next.id
      status = ''
      scheduleCheck(body)
      persistOpenTabs()
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function selectTab(id: string): void {
    if (!tabs.some((t) => t.id === id)) return
    activeId = id
    status = ''
    persistOpenTabs()
  }

  function dropTab(id: string): void {
    const index = tabs.findIndex((t) => t.id === id)
    if (index < 0) return
    tabs.splice(index, 1)
    if (activeId === id) {
      const neighbor = tabs[index] ?? tabs[index - 1] ?? null
      activeId = neighbor?.id ?? null
    }
    persistOpenTabs()
  }

  function closeTab(id: string): void {
    const target = tabs.find((t) => t.id === id)
    if (!target) return
    if (target.body !== target.original) {
      dirtyCloseId = id
      return
    }
    dropTab(id)
  }

  async function saveAndCloseTab(id: string): Promise<void> {
    dirtyCloseId = null
    const target = tabs.find((t) => t.id === id)
    if (!target) return
    activeId = target.id
    const saved = await save()
    if (!saved) return
    dropTab(target.id)
  }

  function discardAndCloseTab(id: string): void {
    dirtyCloseId = null
    dropTab(id)
  }

  function mergeDiagnostics(local: CheckDiagnostic[], server: CheckDiagnostic[]): CheckDiagnostic[] {
    const seen = new Set<string>()
    const out: CheckDiagnostic[] = []
    for (const item of [...local, ...server]) {
      const key = `${item.line ?? ''}:${item.message}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }

  function scheduleCheck(next: string): void {
    const t = currentTab()
    if (!t) return
    t.body = next
    const local = findSyntaxIssues(next)
    t.diagnostics = local
    const seq = ++checkSeq
    const tabId = t.id
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(() => {
      void runCheck(seq, tabId, next, local)
    }, 500)
  }

  async function runCheck(
    seq: number,
    tabId: string,
    text: string,
    local: CheckDiagnostic[]
  ): Promise<void> {
    if (seq !== checkSeq) return
    const t = tabs.find((x) => x.id === tabId)
    if (!t) return
    if (!connected) {
      t.diagnostics = local
      return
    }
    try {
      const server = await window.api.sieve.check(text)
      if (seq !== checkSeq) return
      const live = tabs.find((x) => x.id === tabId)
      if (!live || live.body !== text) return
      live.diagnostics = mergeDiagnostics(local, server)
    } catch (err) {
      if (seq !== checkSeq) return
      const live = tabs.find((x) => x.id === tabId)
      if (live) live.diagnostics = local
      lost(err)
    }
  }

  function newScript(): void {
    actionsMenu = false
    draftSeq += 1
    const next: EditorTab = {
      id: `draft:${draftSeq}`,
      name: null,
      draftName: 'untitled',
      body: NEW_BODY,
      original: NEW_BODY,
      diagnostics: []
    }
    tabs.push(next)
    activeId = next.id
    status = 'New script'
    scheduleCheck(next.body)
    persistOpenTabs()
  }

  function format(): void {
    actionsMenu = false
    const t = currentTab()
    if (!t) return
    const next = formatSieve(t.body, { indentWithTabs, tabSize })
    if (next === t.body) {
      status = 'Already formatted'
      return
    }
    scheduleCheck(next)
    status = indentWithTabs ? `Formatted with tabs (width ${tabSize})` : `Formatted with ${tabSize} spaces`
  }

  async function refreshList(): Promise<void> {
    try {
      const snap = await window.api.sieve.snapshot()
      await applySnapshot(snap.scripts, snap.bodies)
    } catch {
      await applySnapshot(await window.api.sieve.list())
    }
  }

  async function save(): Promise<boolean> {
    const t = currentTab()
    if (!t) return false
    const name = sanitizeScriptName(t.draftName)
    if (!name) {
      error = 'Script name required'
      return false
    }
    if (t.name !== name && scripts.some((s) => s.name === name)) {
      if (!confirm(`Script “${name}” already exists. Replace it on the server?`)) return false
    }
    busy = true
    saving = true
    error = ''
    try {
      await window.api.sieve.put(name, t.body)
      const clash = tabs.find((other) => other.id !== t.id && other.name === name)
      if (clash) {
        const i = tabs.indexOf(clash)
        if (i >= 0) tabs.splice(i, 1)
      }
      t.original = t.body
      t.name = name
      t.draftName = name
      t.id = namedTabId(name)
      activeId = t.id
      await refreshList()
      status = `Saved ${name}`
      scheduleCheck(t.body)
      persistOpenTabs()
      return true
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      saving = false
      busy = false
    }
  }

  async function activate(): Promise<void> {
    actionsMenu = false
    const t = currentTab()
    if (!connected || !t) return
    if (hasErrors) {
      error = 'Fix syntax errors before activating this script.'
      return
    }
    if (dirty) {
      const name = sanitizeScriptName(t.draftName) || t.name
      if (!name) {
        error = 'Script name required'
        return
      }
      if (
        !confirm(
          `Save “${name}” and make it the active script for this mailbox? Unsaved text is not on the server.`
        )
      ) {
        return
      }
      const saved = await save()
      if (!saved) return
    } else {
      const name = t.name
      if (!name) {
        error = 'Save the script before activating it.'
        return
      }
      if (currentIsActive) {
        status = `Already active: ${name}`
        return
      }
      if (
        !confirm(
          `Make “${name}” the active script for this mailbox? Incoming mail will use it until you activate another.`
        )
      ) {
        return
      }
    }
    const name = currentTab()?.name
    if (!name) return
    busy = true
    error = ''
    try {
      await window.api.sieve.activate(name)
      await refreshList()
      status = `Active: ${name}`
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function askName(title: string, value: string, confirmLabel = 'OK'): Promise<string | null> {
    namingDone?.(null)
    naming = { title, value, confirmLabel }
    return new Promise((resolve) => {
      namingDone = resolve
    })
  }

  function finishNaming(value: string | null): void {
    naming = null
    const done = namingDone
    namingDone = null
    done?.(value)
  }

  function unusedCopyName(base: string): string {
    const names = new Set(scripts.map((s) => s.name))
    const root = sanitizeScriptName(base) || 'script'
    if (!names.has(`${root}-copy`)) return `${root}-copy`
    for (let i = 2; i < 100; i++) {
      const next = `${root}-copy-${i}`
      if (!names.has(next)) return next
    }
    return `${root}-copy-${Date.now()}`
  }

  async function duplicate(): Promise<void> {
    actionsMenu = false
    const t = currentTab()
    if (!connected || !t) return
    const suggested = unusedCopyName(t.name || t.draftName || 'script')
    const raw = await askName('Duplicate script', suggested, 'Duplicate')
    const name = raw ? sanitizeScriptName(raw) : ''
    if (!name) return
    if (scripts.some((s) => s.name === name)) {
      if (!confirm(`Script “${name}” already exists. Replace it on the server?`)) return
    }
    busy = true
    error = ''
    try {
      await window.api.sieve.put(name, t.body)
      const next: EditorTab = {
        id: namedTabId(name),
        name,
        draftName: name,
        body: t.body,
        original: t.body,
        diagnostics: [...t.diagnostics]
      }
      const clash = findTabByName(name)
      if (clash && clash.id !== t.id) {
        const i = tabs.indexOf(clash)
        if (i >= 0) tabs.splice(i, 1)
      }
      tabs.push(next)
      activeId = next.id
      await refreshList()
      status = `Duplicated as ${name}`
      scheduleCheck(next.body)
      persistOpenTabs()
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function rename(): Promise<void> {
    actionsMenu = false
    const t = currentTab()
    if (!connected || !t) return
    if (!t.name) {
      error = 'Save the script before renaming it.'
      return
    }
    const raw = await askName(`Rename “${t.name}”`, t.name, 'Rename')
    const next = raw ? sanitizeScriptName(raw) : ''
    if (!next || next === t.name) return
    if (scripts.some((s) => s.name === next)) {
      if (!confirm(`Script “${next}” already exists. Replace it?`)) return
    }
    const oldName = t.name
    const wasActive = scripts.some((s) => s.name === oldName && s.active)
    busy = true
    error = ''
    try {
      await window.api.sieve.put(next, t.body)
      if (wasActive) await window.api.sieve.activate(next)
      try {
        await window.api.sieve.delete(oldName)
      } catch (err) {
        t.original = t.body
        t.name = next
        t.draftName = next
        t.id = namedTabId(next)
        activeId = t.id
        await refreshList()
        error = `Copied to “${next}”, but could not delete “${oldName}”: ${
          err instanceof Error ? err.message : String(err)
        }`
        persistOpenTabs()
        return
      }
      t.original = t.body
      t.name = next
      t.draftName = next
      t.id = namedTabId(next)
      activeId = t.id
      await refreshList()
      status = wasActive ? `Renamed to ${next} (active)` : `Renamed to ${next}`
      persistOpenTabs()
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function exportScript(): Promise<void> {
    actionsMenu = false
    const t = currentTab()
    if (!t) return
    const suggested = sanitizeScriptName(t.draftName || t.name || 'script') || 'script'
    try {
      const result = await window.api.files.exportScript(suggested, t.body)
      if (result.canceled) return
      status = `Exported ${result.path}`
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function importScript(): Promise<void> {
    actionsMenu = false
    try {
      const result = await window.api.files.importScript()
      if (result.canceled) return
      const name = sanitizeScriptName(result.name) || 'imported'
      draftSeq += 1
      const next: EditorTab = {
        id: `draft:${draftSeq}`,
        name: null,
        draftName: name,
        body: result.content,
        original: result.content,
        diagnostics: []
      }
      tabs.push(next)
      activeId = next.id
      status = `Imported ${name} — Save to store it on the server`
      scheduleCheck(next.body)
      persistOpenTabs()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function remove(): Promise<void> {
    actionsMenu = false
    const t = currentTab()
    const name = t?.name
    if (!name) return
    if (!confirm(`Delete script “${name}”?`)) return
    busy = true
    try {
      await window.api.sieve.delete(name)
      for (let i = tabs.length - 1; i >= 0; i--) {
        if (tabs[i].name === name) tabs.splice(i, 1)
      }
      if (!tabs.some((x) => x.id === activeId)) {
        activeId = tabs[tabs.length - 1]?.id ?? null
      }
      await refreshList()
      status = `Deleted ${name}`
      persistOpenTabs()
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function finishDisconnect(): Promise<void> {
    persistOpenTabs()
    await window.api.sieve.disconnect()
    connected = false
    account = null
    capabilities = null
    scripts = []
    bodies = {}
    tabs = []
    activeId = null
    error = ''
    status = ''
    await loadAccounts()
  }

  async function disconnect(): Promise<void> {
    if (anyDirty) {
      disconnectAsk = true
      return
    }
    await finishDisconnect()
  }

  async function saveAndDisconnect(): Promise<void> {
    disconnectAsk = false
    const dirtyTabs = tabs.filter((t) => t.body !== t.original)
    for (const t of dirtyTabs) {
      activeId = t.id
      const saved = await save()
      if (!saved) return
    }
    await finishDisconnect()
  }

  async function removeSavedAccount(id: number): Promise<void> {
    await window.api.accounts.remove(id)
    if (lastInput?.id === id) lastInput = null
    await loadAccounts()
  }

  onMount(() => {
    const off = window.api.sieve.onDisconnected((reason) => markDisconnected(reason))
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.repeat) return
      if (e.key.toLowerCase() !== 's') return
      e.preventDefault()
      if (!account || !connected || busy || naming || dirtyCloseId || disconnectAsk || !tab) return
      void save()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      off()
      window.removeEventListener('keydown', onKey, true)
    }
  })

  void loadAccounts()
</script>

{#if !account}
  <Login
    {accounts}
    {busy}
    {error}
    {appName}
    {appVersion}
    preferredId={lastInput?.id ?? null}
    onconnect={connect}
    onremove={removeSavedAccount}
    oncheckupdates={() => void window.api.app.checkForUpdates()}
  />
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center gap-3 border-b border-line bg-panel px-3 py-2">
      <img src={icon} alt="" class="size-8 shrink-0 rounded-lg" />
      <div class="min-w-0 flex-1 text-sm">
        <div class="flex min-w-0 items-baseline gap-2 font-medium">
          <span class="truncate">{appName}</span>
          {#if appVersion}
            <button
              type="button"
              class="shrink-0 font-normal text-zinc-400 hover:text-zinc-200"
              title="Check for updates"
              onclick={() => void window.api.app.checkForUpdates()}
            >
              {appVersion}
            </button>
          {/if}
        </div>
        <div class="truncate text-xs text-zinc-400">
          {account?.username}@{account?.host}:{account?.port}
          {#if connected}
            <span> · {capabilities?.implementation ?? 'ManageSieve'}</span>
          {:else}
            <span class="text-warn"> · Disconnected</span>
          {/if}
          {#if dirty}<span class="text-warn"> • unsaved</span>{/if}
        </div>
      </div>
      <input
        class="w-48 rounded border border-line bg-ink px-2 py-1 text-sm disabled:opacity-50"
        value={tab?.draftName ?? ''}
        disabled={!tab}
        title="Script name"
        oninput={(e) => {
          const t = currentTab()
          if (t) t.draftName = (e.currentTarget as HTMLInputElement).value
        }}
      />
      <button class="rounded bg-accent px-3 py-1 text-sm text-ink disabled:opacity-50" onclick={() => void save()} disabled={busy || !connected || !tab}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <div class="relative">
        <button
          class="rounded border border-line px-3 py-1 text-sm"
          disabled={busy}
          onclick={(e) => {
            e.stopPropagation()
            actionsMenu = !actionsMenu
          }}
        >
          Actions
        </button>
        {#if actionsMenu}
          <div
            class="fixed inset-0 z-10"
            role="presentation"
            onclick={() => (actionsMenu = false)}
          ></div>
          <div
            class="absolute right-0 z-20 mt-1 w-44 rounded border border-line bg-panel py-1 shadow-xl"
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink"
              onclick={newScript}
            >
              New
            </button>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink disabled:opacity-50"
              disabled={!tab}
              onclick={format}
            >
              Format
            </button>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink disabled:opacity-50"
              disabled={!connected || !tab}
              onclick={() => void duplicate()}
            >
              Duplicate…
            </button>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink disabled:opacity-50"
              disabled={!connected || !currentName}
              onclick={() => void rename()}
            >
              Rename…
            </button>
            <div class="my-1 border-t border-line"></div>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink disabled:opacity-50"
              disabled={!connected || !tab || hasErrors || (!currentName && !dirty) || (currentIsActive && !dirty)}
              title={hasErrors
                ? 'Fix syntax errors before activating'
                : currentIsActive && !dirty
                  ? 'Already the active script'
                  : 'Make this the active script for incoming mail'}
              onclick={() => void activate()}
            >
              Activate
            </button>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-ink disabled:opacity-50"
              disabled={!connected || !currentName}
              onclick={() => void remove()}
            >
              Delete
            </button>
            <div class="my-1 border-t border-line"></div>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink disabled:opacity-50"
              disabled={!tab}
              onclick={() => void exportScript()}
            >
              Export…
            </button>
            <button
              type="button"
              role="menuitem"
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink"
              onclick={() => void importScript()}
            >
              Import…
            </button>
          </div>
        {/if}
      </div>
      <label class="flex items-center gap-1 text-xs text-zinc-400" title="Indent with tabs or spaces">
        <select
          class="rounded border border-line bg-ink px-1 py-1 text-xs"
          value={indentWithTabs ? 'tab' : 'space'}
          onchange={(e) => {
            const useTabs = (e.currentTarget as HTMLSelectElement).value === 'tab'
            void savePrefs({ indentWithTabs: useTabs, tabSize })
          }}
        >
          <option value="tab">Tabs</option>
          <option value="space">Spaces</option>
        </select>
      </label>
      <label class="flex items-center gap-1 text-xs text-zinc-400" title="Tab width">
        <select
          class="rounded border border-line bg-ink px-1 py-1 text-xs"
          value={String(tabSize)}
          onchange={(e) => {
            const size = Number((e.currentTarget as HTMLSelectElement).value)
            void savePrefs({ indentWithTabs, tabSize: size })
          }}
        >
          <option value="2">2</option>
          <option value="4">4</option>
          <option value="8">8</option>
        </select>
      </label>
      {#if connected}
        <button class="rounded border border-line px-3 py-1 text-sm" onclick={disconnect} disabled={busy}>
          Disconnect
        </button>
      {:else}
        <button
          class="rounded bg-accent px-3 py-1 text-sm text-ink disabled:opacity-50"
          onclick={reconnect}
          disabled={busy || !lastInput}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      {/if}
    </header>

    <div class="flex min-h-0 flex-1">
      <aside class="w-72 shrink-0 overflow-auto border-r border-line bg-panel">
        <ScriptTree rows={treeRows} unused={graph.unused} {currentName} onopen={openScript} />
      </aside>
      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        <ScriptTabs tabs={tabInfos} onselect={selectTab} onclose={closeTab} />
        <div class="min-h-0 min-w-0 flex-1">
          {#if tab}
            {#key tab.id}
              <SieveEditor
                value={tab.body}
                {keywords}
                diagnostics={tab.diagnostics}
                {indentWithTabs}
                {tabSize}
                onchange={scheduleCheck}
              />
            {/key}
          {:else}
            <p class="p-6 text-sm text-zinc-500">Open a script from the list, or Actions → New.</p>
          {/if}
        </div>
      </main>
    </div>

    <footer class="border-t border-line bg-panel px-3 py-1 text-xs text-zinc-400">
      {#if error}
        <span class="text-red-300">{error}</span>
      {:else}
        {status || (tab?.diagnostics[0]?.message ?? 'Ready')}
      {/if}
    </footer>
  </div>
{/if}

{#if dirtyCloseId}
  {@const closing = tabs.find((t) => t.id === dirtyCloseId)}
  <DirtyClosePrompt
    title="{closing?.draftName || closing?.name || 'Script'} has unsaved changes"
    detail="Save this script, or discard the buffer?"
    onsave={() => void saveAndCloseTab(dirtyCloseId!)}
    ondiscard={() => discardAndCloseTab(dirtyCloseId!)}
    oncancel={() => (dirtyCloseId = null)}
  />
{/if}

{#if disconnectAsk}
  <DirtyClosePrompt
    title="Unsaved changes"
    detail="Save dirty scripts before disconnecting, or discard them?"
    onsave={() => void saveAndDisconnect()}
    ondiscard={() => {
      disconnectAsk = false
      void finishDisconnect()
    }}
    oncancel={() => (disconnectAsk = false)}
  />
{/if}

{#if naming}
  <NamePrompt
    title={naming.title}
    value={naming.value}
    confirmLabel={naming.confirmLabel}
    onconfirm={(name) => finishNaming(name)}
    oncancel={() => finishNaming(null)}
  />
{/if}
