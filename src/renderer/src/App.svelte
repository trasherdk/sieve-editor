<script lang="ts">
  import Login from './Login.svelte'
  import SieveEditor from './SieveEditor.svelte'
  import ScriptTree from './ScriptTree.svelte'
  import { buildScriptGraph, flattenTree } from '@shared/includes'
  import type {
    AccountInput,
    AccountRecord,
    Capabilities,
    CheckDiagnostic,
    ConnectResult,
    ScriptBodies,
    SieveScript
  } from '@shared/types'

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

  const dirty = $derived(body !== original)
  const keywords = $derived(capabilities?.sieve ?? [])
  const graph = $derived.by(() => {
    const next = { ...bodies }
    if (currentName) next[currentName] = body
    return buildScriptGraph(scripts, next)
  })
  const treeRows = $derived(graph.root ? flattenTree(graph.root) : [])

  async function loadAccounts(): Promise<void> {
    accounts = await window.api.accounts.list()
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

  async function connect(input: AccountInput): Promise<void> {
    busy = true
    error = ''
    try {
      const result: ConnectResult = await window.api.sieve.connect(input)
      account = result.account
      capabilities = result.capabilities
      await applySnapshot(result.scripts, result.bodies)
      connected = true
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
      await loadAccounts()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function openScript(name: string): Promise<void> {
    if (name === currentName) return
    if (dirty && !confirm('Discard unsaved changes?')) return
    busy = true
    error = ''
    try {
      body = await window.api.sieve.get(name)
      original = body
      currentName = name
      draftName = name
      diagnostics = []
      status = ''
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function scheduleCheck(next: string): void {
    body = next
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(() => {
      void runCheck(next)
    }, 700)
  }

  async function runCheck(text: string): Promise<void> {
    try {
      diagnostics = await window.api.sieve.check(text)
    } catch {
      diagnostics = []
    }
  }

  function newScript(): void {
    if (dirty && !confirm('Discard unsaved changes?')) return
    currentName = null
    draftName = 'untitled'
    body = 'require ["fileinto"];\n\n'
    original = body
    diagnostics = []
    status = 'New script'
  }

  async function refreshList(): Promise<void> {
    try {
      const snap = await window.api.sieve.snapshot()
      await applySnapshot(snap.scripts, snap.bodies)
    } catch {
      await applySnapshot(await window.api.sieve.list())
    }
  }

  async function save(): Promise<void> {
    const name = draftName.trim()
    if (!name) {
      error = 'Script name required'
      return
    }
    busy = true
    error = ''
    try {
      await window.api.sieve.put(name, body)
      original = body
      currentName = name
      await refreshList()
      status = `Saved ${name}`
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function activate(): Promise<void> {
    const name = currentName
    if (!name) return
    busy = true
    try {
      await window.api.sieve.activate(name)
      await refreshList()
      status = `Active: ${name}`
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
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
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function disconnect(): Promise<void> {
    await window.api.sieve.disconnect()
    connected = false
    account = null
    scripts = []
    bodies = {}
    currentName = null
    body = ''
    original = ''
    error = ''
    await loadAccounts()
  }

  void loadAccounts()
</script>

{#if !connected}
  <Login {accounts} {busy} {error} onconnect={connect} />
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center gap-3 border-b border-line bg-panel px-3 py-2">
      <div class="min-w-0 flex-1 text-sm">
        <div class="truncate font-medium">
          {account?.username}@{account?.host}:{account?.port}
        </div>
        <div class="truncate text-xs text-zinc-400">
          {capabilities?.implementation ?? 'ManageSieve'}
          {#if dirty}<span class="text-warn"> • unsaved</span>{/if}
        </div>
      </div>
      <input
        class="w-48 rounded border border-line bg-ink px-2 py-1 text-sm"
        bind:value={draftName}
        title="Script name"
      />
      <button class="rounded border border-line px-3 py-1 text-sm" onclick={newScript} disabled={busy}>
        New
      </button>
      <button class="rounded bg-accent px-3 py-1 text-sm text-ink disabled:opacity-50" onclick={save} disabled={busy}>
        Save
      </button>
      <button class="rounded border border-line px-3 py-1 text-sm" onclick={activate} disabled={busy || !currentName}>
        Activate
      </button>
      <button class="rounded border border-bad/50 px-3 py-1 text-sm text-red-300" onclick={remove} disabled={busy || !currentName}>
        Delete
      </button>
      <button class="rounded border border-line px-3 py-1 text-sm" onclick={disconnect}>Disconnect</button>
    </header>

    <div class="flex min-h-0 flex-1">
      <aside class="w-72 shrink-0 overflow-auto border-r border-line bg-panel">
        <ScriptTree rows={treeRows} unused={graph.unused} {currentName} onopen={openScript} />
      </aside>
      <main class="min-h-0 min-w-0 flex-1">
        <SieveEditor value={body} {keywords} {diagnostics} onchange={scheduleCheck} />
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
