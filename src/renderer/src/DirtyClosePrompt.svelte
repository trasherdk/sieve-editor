<script lang="ts">
  import { onMount } from 'svelte'

  let {
    title,
    detail = '',
    onsave,
    ondiscard,
    oncancel
  }: {
    title: string
    detail?: string
    onsave: () => void
    ondiscard: () => void
    oncancel: () => void
  } = $props()

  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') oncancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={oncancel}
>
  <div
    class="w-full max-w-sm rounded-xl border border-line bg-panel p-4 shadow-xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h2 class="text-sm font-medium">{title}</h2>
    {#if detail}
      <p class="mt-2 text-sm text-zinc-400">{detail}</p>
    {/if}
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class="rounded border border-line px-3 py-1 text-sm" onclick={ondiscard}>
        Discard
      </button>
      <button type="button" class="rounded border border-line px-3 py-1 text-sm" onclick={oncancel}>
        Cancel
      </button>
      <button type="button" class="rounded bg-accent px-3 py-1 text-sm text-ink" onclick={onsave}>
        Save
      </button>
    </div>
  </div>
</div>
