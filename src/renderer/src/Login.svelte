<script lang="ts">
  import type { AccountInput, AccountRecord, TlsMode } from '@shared/types'
  import { DEFAULT_HOST, DEFAULT_PORT } from '@shared/types'

  let {
    accounts,
    busy,
    error,
    onconnect
  }: {
    accounts: AccountRecord[]
    busy: boolean
    error: string
    onconnect: (input: AccountInput) => void
  } = $props()

  let host = $state(DEFAULT_HOST)
  let port = $state(DEFAULT_PORT)
  let username = $state('')
  let password = $state('')
  let tlsMode = $state<TlsMode>('starttls')
  let rejectUnauthorized = $state(true)
  let rememberPassword = $state(true)
  let selectedId = $state<number | undefined>(undefined)

  function pick(account: AccountRecord): void {
    selectedId = account.id
    host = account.host
    port = account.port
    username = account.username
    tlsMode = account.tlsMode
    rejectUnauthorized = account.rejectUnauthorized
    password = ''
  }

  $effect(() => {
    if (!selectedId && accounts[0]) pick(accounts[0])
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
</script>

<div class="flex min-h-full items-center justify-center p-8">
  <form
    class="w-full max-w-lg rounded-xl border border-line bg-panel p-6 shadow-xl"
    onsubmit={submit}
  >
    <h1 class="mb-1 text-xl font-semibold">Sieve</h1>
    <p class="mb-5 text-sm text-zinc-400">Connect to Cyrus ManageSieve</p>

    {#if accounts.length}
      <p class="mb-3 text-xs uppercase tracking-wide text-zinc-400">Saved accounts</p>
      <div class="mb-4 flex flex-col gap-1">
        {#each accounts as account (account.id)}
          <button
            type="button"
            class="rounded border border-line px-3 py-2 text-left text-sm hover:border-accent {selectedId ===
            account.id
              ? 'border-accent bg-ink'
              : ''}"
            onclick={() => pick(account)}
          >
            {account.username}@{account.host}:{account.port}
          </button>
        {/each}
      </div>
    {/if}

    <div class="grid grid-cols-3 gap-3">
      <label class="col-span-2 text-sm">
        Host
        <input
          class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5"
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
          placeholder={selectedId ? 'Saved password used if empty' : ''}
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
