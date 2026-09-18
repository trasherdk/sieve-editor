<script lang="ts">
  import { onMount } from 'svelte'
  import type { AccountInput, AccountRecord, TlsMode } from '@shared/types'
  import { DEFAULT_HOST, DEFAULT_PORT } from '@shared/types'

  let {
    accounts,
    busy,
    error,
    preferredId = null,
    onconnect,
    onremove
  }: {
    accounts: AccountRecord[]
    busy: boolean
    error: string
    preferredId?: number | null
    onconnect: (input: AccountInput) => void
    onremove: (id: number) => void
  } = $props()

  let host = $state(DEFAULT_HOST)
  let port = $state(DEFAULT_PORT)
  let username = $state('')
  let password = $state('')
  let tlsMode = $state<TlsMode>('starttls')
  let rejectUnauthorized = $state(true)
  let rememberPassword = $state(true)
  let selectedId = $state<number | undefined>(undefined)
  let composingNew = $state(false)
  let listEl: HTMLDivElement | undefined = $state()
  let hostEl: HTMLInputElement | undefined = $state()

  function pick(account: AccountRecord): void {
    composingNew = false
    selectedId = account.id
    host = account.host
    port = account.port
    username = account.username
    tlsMode = account.tlsMode
    rejectUnauthorized = account.rejectUnauthorized
    password = ''
    rememberPassword = account.hasPassword
  }

  function addNew(): void {
    composingNew = true
    selectedId = undefined
    host = DEFAULT_HOST
    port = DEFAULT_PORT
    username = ''
    password = ''
    tlsMode = 'starttls'
    rejectUnauthorized = true
    rememberPassword = true
    queueMicrotask(() => hostEl?.focus())
  }

  $effect(() => {
    if (composingNew) return
    if (selectedId != null && !accounts.some((a) => a.id === selectedId)) selectedId = undefined
    if (selectedId != null) return
    const preferred = (preferredId && accounts.find((a) => a.id === preferredId)) || accounts[0]
    if (preferred) pick(preferred)
  })

  onMount(() => {
    const id = preferredId ?? selectedId
    const btn = id != null ? listEl?.querySelector(`[data-account-id="${id}"]`) : listEl?.querySelector('button')
    if (btn instanceof HTMLElement) btn.focus()
  })

  function submit(e: Event): void {
    e.preventDefault()
    onconnect({
      id: selectedId,
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      password,
      rememberPassword,
      tlsMode,
      rejectUnauthorized
    })
  }

  function removeAccount(e: MouseEvent, id: number): void {
    e.stopPropagation()
    e.preventDefault()
    if (!confirm('Remove this saved account?')) return
    if (selectedId === id) {
      selectedId = undefined
      composingNew = false
    }
    onremove(id)
  }
</script>

<div class="flex min-h-full items-center justify-center p-8">
  <form
    class="w-full max-w-lg rounded-xl border border-line bg-panel p-6 shadow-xl"
    onsubmit={submit}
  >
    <h1 class="mb-1 text-xl font-semibold">Sieve</h1>
    <p class="mb-5 text-sm text-zinc-400">Connect to a ManageSieve server</p>

    <div class="mb-4 flex items-center justify-between">
      <p class="text-xs uppercase tracking-wide text-zinc-400">Accounts</p>
      <button
        type="button"
        class="rounded border border-line px-2 py-1 text-xs hover:border-accent"
        onclick={addNew}
      >
        Add account
      </button>
    </div>

    {#if accounts.length}
      <div bind:this={listEl} class="mb-4 flex max-h-48 flex-col gap-1 overflow-y-auto" tabindex="-1">
        {#each accounts as account (account.id)}
          <div class="flex items-stretch gap-1">
            <button
              type="button"
              data-account-id={account.id}
              class="min-w-0 flex-1 rounded border px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-accent {selectedId ===
              account.id
                ? 'border-accent bg-ink'
                : 'border-line hover:border-accent'}"
              onclick={() => pick(account)}
              ondblclick={() => {
                pick(account)
                onconnect({
                  id: account.id,
                  host: account.host,
                  port: account.port,
                  username: account.username,
                  password,
                  rememberPassword: account.hasPassword,
                  tlsMode: account.tlsMode,
                  rejectUnauthorized: account.rejectUnauthorized
                })
              }}
            >
              <span class="block truncate">{account.username}@{account.host}:{account.port}</span>
              <span class="block text-xs text-zinc-400">
                {account.hasPassword ? 'Saved password' : 'Password required'}
              </span>
            </button>
            <button
              type="button"
              class="rounded border border-line px-2 text-sm text-zinc-400 hover:border-bad/50 hover:text-red-300"
              title="Remove account"
              onclick={(e) => removeAccount(e, account.id)}
            >
              ×
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="mb-4 text-sm text-zinc-400">No saved accounts yet. Fill in a server below.</p>
    {/if}

    {#if composingNew}
      <p class="mb-3 text-xs text-accent">New account</p>
    {/if}

    <div class="grid grid-cols-3 gap-3">
      <label class="col-span-2 text-sm">
        Host
        <input
          class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5"
          bind:this={hostEl}
          bind:value={host}
        />
      </label>
      <label class="text-sm">
        Port
        <input
          class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5"
          type="number"
          bind:value={port}
        />
      </label>
      <label class="col-span-3 text-sm">
        Username
        <input
          class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5"
          bind:value={username}
          autocomplete="username"
        />
      </label>
      <label class="col-span-3 text-sm">
        Password
        <input
          class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5"
          type="password"
          bind:value={password}
          autocomplete="current-password"
          placeholder={selectedId && rememberPassword ? 'Saved password used if empty' : ''}
        />
      </label>
      <label class="col-span-3 text-sm">
        TLS
        <select class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5" bind:value={tlsMode}>
          <option value="starttls">STARTTLS (required)</option>
          <option value="optional">STARTTLS if offered</option>
          <option value="plaintext">Plaintext (fallback)</option>
        </select>
      </label>
    </div>

    <label class="mt-3 flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={rejectUnauthorized} />
      Verify TLS certificate (OS trust store)
    </label>
    <label class="mt-2 flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={rememberPassword} />
      Remember password (encrypted)
    </label>

    {#if error}
      <p class="mt-4 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-red-300">{error}</p>
    {/if}

    <button
      class="mt-5 w-full rounded bg-accent px-3 py-2 font-medium text-ink disabled:opacity-50"
      type="submit"
      disabled={busy}
    >
      {busy ? 'Connecting…' : 'Connect'}
    </button>
  </form>
</div>
