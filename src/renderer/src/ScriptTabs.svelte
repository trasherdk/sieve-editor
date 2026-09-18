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

<div class="flex min-h-9 shrink-0 gap-0.5 overflow-x-auto border-b border-line bg-ink px-1.5 pt-1" role="tablist">
  {#each tabs as tab (tab.id)}
    <div
      class="group relative flex max-w-52 shrink-0 items-stretch rounded-t border border-b-0 {tab.active
        ? 'z-10 -mb-px border-line border-t-2 border-t-accent bg-tab-active text-zinc-100'
        : 'border-line/70 border-t-2 border-t-transparent bg-tab text-zinc-400 hover:bg-hover hover:text-zinc-100'}"
    >
      <button
        type="button"
        role="tab"
        aria-selected={tab.active}
        class="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left text-xs"
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
        class="px-1.5 text-zinc-500 hover:text-zinc-100 {tab.active ? '' : 'opacity-0 group-hover:opacity-100'}"
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
