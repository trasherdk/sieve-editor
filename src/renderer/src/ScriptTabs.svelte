<script lang="ts">
  export type ScriptTabInfo = {
    id: string
    label: string
    dirty: boolean
    active: boolean
  }

  let { tabs, onselect, onclose } = $props<{
    tabs: ScriptTabInfo[]
    onselect: (id: string) => void
    onclose: (id: string) => void
  }>()
</script>

<div class="flex min-h-8 shrink-0 overflow-x-auto border-b border-line bg-panel" role="tablist">
  {#each tabs as tab (tab.id)}
    <div
      class="group flex max-w-52 shrink-0 items-stretch border-r border-line {tab.active
        ? 'bg-ink'
        : 'bg-panel hover:bg-ink/60'}"
    >
      <button
        type="button"
        role="tab"
        aria-selected={tab.active}
        class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs {tab.active
          ? 'text-zinc-100'
          : 'text-zinc-400'}"
        title={tab.label}
        onclick={() => onselect(tab.id)}
        onauxclick={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            onclose(tab.id)
          }
        }}
      >
        {#if tab.dirty}
          <span class="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true"></span>
        {/if}
        <span class="min-w-0 truncate">{tab.label}</span>
      </button>
      <button
        type="button"
        class="px-1.5 text-zinc-500 hover:text-zinc-200 {tab.active ? '' : 'opacity-0 group-hover:opacity-100'}"
        title="Close"
        aria-label={`Close ${tab.label}`}
        onclick={(e) => {
          e.stopPropagation()
          onclose(tab.id)
        }}
      >
        ×
      </button>
    </div>
  {/each}
</div>
