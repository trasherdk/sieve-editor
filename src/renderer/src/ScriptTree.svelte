<script lang="ts">
  import type { ScriptTreeKind, ScriptTreeRow } from '@shared/includes'

  let { rows, unused, currentName, onopen } = $props<{
    rows: ScriptTreeRow[]
    unused: string[]
    currentName: string | null
    onopen: (name: string) => void
  }>()

  function kindLabel(kind: ScriptTreeKind): string | null {
    if (kind === 'active') return 'active'
    if (kind === 'global') return ':global'
    if (kind === 'missing') return 'missing'
    if (kind === 'cycle') return 'already above'
    return null
  }

  function kindClass(kind: ScriptTreeKind): string {
    if (kind === 'active') return 'text-ok'
    if (kind === 'global') return 'text-accent'
    if (kind === 'missing') return 'text-bad'
    if (kind === 'cycle') return 'text-warn'
    return 'text-zinc-500'
  }

  function rowClass(row: ScriptTreeRow): string {
    const selected = currentName === row.name && row.openable
    const base =
      'flex w-full min-w-0 items-center gap-1 px-2 py-0.5 text-left text-sm leading-5'
    if (!row.openable) return `${base} cursor-default text-zinc-500`
    if (selected) return `${base} bg-ink text-accent`
    return `${base} hover:bg-ink`
  }
</script>

<div class="px-3 py-2 text-xs uppercase tracking-wide text-zinc-500">Scripts</div>
{#each rows as row (row.id)}
  {#if row.spacer}
    <div class="px-2 font-mono text-sm leading-none text-zinc-500 whitespace-pre select-none" aria-hidden="true">
      {row.gutter}
    </div>
  {:else}
    <button
      class={rowClass(row)}
      disabled={!row.openable}
      title={row.kind === 'missing'
        ? `${row.name} is not on the server`
        : row.kind === 'global'
          ? `${row.name} is a global script`
          : row.name}
      onclick={() => row.openable && onopen(row.name)}
    >
      <span class="shrink-0 font-mono text-sm leading-5 text-zinc-500 whitespace-pre">{row.gutter}</span>
      <span class="min-w-0 overflow-x-hidden text-ellipsis whitespace-nowrap {row.kind === 'missing' ? 'text-bad' : ''}">{row.name}</span>
      {#if kindLabel(row.kind)}
        <span class="shrink-0 text-xs {kindClass(row.kind)}">{kindLabel(row.kind)}</span>
      {/if}
    </button>
  {/if}
{/each}
{#if unused.length}
  {#if rows.length}
    <div class="mt-2 px-3 py-2 text-xs uppercase tracking-wide text-zinc-500">Unused</div>
  {/if}
  {#each unused as name (name)}
    <button
      class="block w-full overflow-x-hidden px-3 py-0.5 text-left text-sm leading-5 text-ellipsis whitespace-nowrap hover:bg-ink {currentName === name
        ? 'bg-ink text-accent'
        : ''}"
      onclick={() => onopen(name)}
    >
      {name}
    </button>
  {/each}
{/if}
{#if !rows.length && !unused.length}
  <p class="px-3 text-sm text-zinc-500">No scripts yet</p>
{/if}
