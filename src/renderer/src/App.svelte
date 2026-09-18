<script lang="ts">
  import { onMount } from 'svelte'
  import Login from './Login.svelte'
  import SieveEditor from './SieveEditor.svelte'
  import ScriptTree from './ScriptTree.svelte'
  import NamePrompt from './NamePrompt.svelte'
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
  import { APP_NAME } from '@shared/app'
  import icon from './assets/icon.png'

  let appName = $state(APP_NAME)
  let appVersion = $state('')

  let accounts = $state<AccountRecord[]>([])
  let busy = $state(false)
  let error = $state('')
  let connected = $state(false)
  let account = $state<AccountRecord | null>(null)
  let capabilities = $state<Capabilities | null>(null)
  let scripts = $state<SieveScript[]>([])
  let bodies = $state<ScriptBodies>({})
  let currentName = $state<string | null>(null)
  let draftName = $state('')
  let body = $state('')
  let original = $state('')
  let status = $state('')
  let diagnostics = $state<CheckDiagnostic[]>([])
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let checkSeq = 0
  let indentWithTabs = $state(DEFAULT_INDENT_WITH_TABS)
  let tabSize = $state(DEFAULT_TAB_SIZE)
  let lastInput = $state.raw<AccountInput | null>(null)
  let actionsMenu = $state(false)
  let naming = $state<{ title: string; value: string; confirmLabel: string } | null>(null)
  let namingDone: ((value: string | null) => void) | null = null

  const dirty = $derived(body !== original)
  const keywords = $derived(capabilities?.sieve ?? [])
  const hasErrors = $derived(diagnostics.some((d) => d.severity === 'error'))
  const currentIsActive = $derived(
    Boolean(currentName && scripts.some((s) => s.name === currentName && s.active))
  )
  const graph = $derived.by(() => {
    const next = { ...bodies }
    if (currentName) next[currentName] = body
    return buildScriptGraph(scripts, next)
  })
  const treeRows = $derived(graph.root ? flattenTree(graph.root) : [])

  async function loadAccounts(): Promise<void> {
    const info = await window.api.app.info()
    appName = info.name
    appVersion = info.version
    document.title = `${info.name} ${info.version}`
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
        const preferred =
          account.lastScript && scripts.some((s) => s.name === account!.lastScript)
            ? account.lastScript
            : scripts.find((s) => s.active)?.name || scripts[0]?.name || null
        if (preferred) await openScript(preferred)
        else {
          currentName = null
          draftName = 'untitled'
          body = ''
          original = ''
        }
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
    if (name === currentName) return
    if (dirty && !confirm('Discard unsaved changes?')) return
    if (!connected) {
      error = 'Not connected'
      return
    }
    busy = true
    error = ''
    try {
      body = await window.api.sieve.get(name)
      original = body
      currentName = name
      draftName = name
      diagnostics = []
      status = ''
      scheduleCheck(body)
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
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
    body = next
    const local = findSyntaxIssues(next)
    diagnostics = local
    const seq = ++checkSeq
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(() => {
      void runCheck(seq, next, local)
    }, 500)
  }

  async function runCheck(seq: number, text: string, local: CheckDiagnostic[]): Promise<void> {
    if (seq !== checkSeq) return
    if (!connected) {
      diagnostics = local
      return
    }
    try {
      const server = await window.api.sieve.check(text)
      if (seq !== checkSeq) return
      diagnostics = mergeDiagnostics(local, server)
    } catch (err) {
      if (seq !== checkSeq) return
      diagnostics = local
      lost(err)
    }
  }

  function newScript(): void {
    actionsMenu = false
    if (dirty && !confirm('Discard unsaved changes?')) return
    currentName = null
    draftName = 'untitled'
    body = 'require ["fileinto"];\n\n'
    original = body
    diagnostics = []
    status = 'New script'
    scheduleCheck(body)
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
    const name = sanitizeScriptName(draftName)
    if (!name) {
      error = 'Script name required'
      return false
    }
    if (currentName !== name && scripts.some((s) => s.name === name)) {
      if (!confirm(`Script “${name}” already exists. Replace it on the server?`)) return false
    }
    busy = true
    error = ''
    try {
      await window.api.sieve.put(name, body)
      original = body
      currentName = name
      draftName = name
      await refreshList()
      status = `Saved ${name}`
      scheduleCheck(body)
      return true
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      busy = false
    }
  }

  async function activate(): Promise<void> {
    actionsMenu = false
    if (!connected) return
    if (hasErrors) {
      error = 'Fix syntax errors before activating this script.'
      return
    }
    if (dirty) {
      const name = sanitizeScriptName(draftName) || currentName
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
      const name = currentName
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
    const name = currentName
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
    if (!connected) return
    const suggested = unusedCopyName(currentName || draftName || 'script')
    const raw = await askName('Duplicate script', suggested, 'Duplicate')
    const name = raw ? sanitizeScriptName(raw) : ''
    if (!name) return
    if (scripts.some((s) => s.name === name)) {
      if (!confirm(`Script “${name}” already exists. Replace it on the server?`)) return
    }
    busy = true
    error = ''
    try {
      await window.api.sieve.put(name, body)
      original = body
      currentName = name
      draftName = name
      await refreshList()
      status = `Duplicated as ${name}`
      scheduleCheck(body)
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function rename(): Promise<void> {
    actionsMenu = false
    if (!connected) return
    if (!currentName) {
      error = 'Save the script before renaming it.'
      return
    }
    const raw = await askName(`Rename “${currentName}”`, currentName, 'Rename')
    const next = raw ? sanitizeScriptName(raw) : ''
    if (!next || next === currentName) return
    if (scripts.some((s) => s.name === next)) {
      if (!confirm(`Script “${next}” already exists. Replace it?`)) return
    }
    const oldName = currentName
    const wasActive = scripts.some((s) => s.name === oldName && s.active)
    busy = true
    error = ''
    try {
      await window.api.sieve.put(next, body)
      if (wasActive) await window.api.sieve.activate(next)
      try {
        await window.api.sieve.delete(oldName)
      } catch (err) {
        original = body
        currentName = next
        draftName = next
        await refreshList()
        error = `Copied to “${next}”, but could not delete “${oldName}”: ${
          err instanceof Error ? err.message : String(err)
        }`
        return
      }
      original = body
      currentName = next
      draftName = next
      await refreshList()
      status = wasActive ? `Renamed to ${next} (active)` : `Renamed to ${next}`
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function exportScript(): Promise<void> {
    actionsMenu = false
    const suggested = sanitizeScriptName(draftName || currentName || 'script') || 'script'
    try {
      const result = await window.api.files.exportScript(suggested, body)
      if (result.canceled) return
      status = `Exported ${result.path}`
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function importScript(): Promise<void> {
    actionsMenu = false
    if (dirty && !confirm('Discard unsaved changes?')) return
    try {
      const result = await window.api.files.importScript()
      if (result.canceled) return
      const name = sanitizeScriptName(result.name) || 'imported'
      currentName = null
      draftName = name
      body = result.content
      original = result.content
      diagnostics = []
      status = `Imported ${name} — Save to store it on the server`
      scheduleCheck(body)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function remove(): Promise<void> {
    actionsMenu = false
    const name = currentName
    if (!name) return
    if (!confirm(`Delete script “${name}”?`)) return
    busy = true
    try {
      await window.api.sieve.delete(name)
      currentName = null
      draftName = 'untitled'
      body = ''
      original = ''
      await refreshList()
      status = `Deleted ${name}`
    } catch (err) {
      if (!lost(err)) error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function disconnect(): Promise<void> {
    if (dirty && !confirm('Discard unsaved changes?')) return
    await window.api.sieve.disconnect()
    connected = false
    account = null
    capabilities = null
    scripts = []
    bodies = {}
    currentName = null
    draftName = ''
    body = ''
    original = ''
    diagnostics = []
    error = ''
    status = ''
    await loadAccounts()
  }

  async function removeSavedAccount(id: number): Promise<void> {
    await window.api.accounts.remove(id)
    if (lastInput?.id === id) lastInput = null
    await loadAccounts()
  }

  onMount(() => {
    return window.api.sieve.onDisconnected((reason) => markDisconnected(reason))
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
        class="w-48 rounded border border-line bg-ink px-2 py-1 text-sm"
        bind:value={draftName}
        title="Script name"
      />
      <button class="rounded bg-accent px-3 py-1 text-sm text-ink disabled:opacity-50" onclick={() => void save()} disabled={busy || !connected}>
        Save
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
              disabled={!connected}
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
              disabled={!connected || hasErrors || (!currentName && !dirty) || (currentIsActive && !dirty)}
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
              class="block w-full px-3 py-1.5 text-left text-sm hover:bg-ink"
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
      <main class="min-h-0 min-w-0 flex-1">
        <SieveEditor
          value={body}
          {keywords}
          {diagnostics}
          {indentWithTabs}
          {tabSize}
          onchange={scheduleCheck}
        />
      </main>
    </div>

    <footer class="border-t border-line bg-panel px-3 py-1 text-xs text-zinc-400">
      {#if error}
        <span class="text-red-300">{error}</span>
      {:else}
        {status || (diagnostics[0]?.message ?? 'Ready')}
      {/if}
    </footer>
  </div>
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
