<script lang="ts">
  import { onMount } from 'svelte'

  let {
    title,
    label = 'Script name',
    value = '',
    confirmLabel = 'OK',
    onconfirm,
    oncancel
  }: {
    title: string
    label?: string
    value?: string
    confirmLabel?: string
    onconfirm: (name: string) => void
    oncancel: () => void
  } = $props()

  let name = $state('')
  let input: HTMLInputElement | undefined = $state()

  onMount(() => {
    name = value
    input?.focus()
    input?.select()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') oncancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function submit(e: Event): void {
    e.preventDefault()
    const next = name.trim()
    if (!next) return
    onconfirm(next)
  }
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
    <form onsubmit={submit}>
      <h2 class="mb-3 text-sm font-medium">{title}</h2>
      <label class="block text-sm">
        {label}
        <input
          bind:this={input}
          bind:value={name}
          class="mt-1 w-full rounded border border-line bg-ink px-2 py-1.5"
        />
      </label>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="rounded border border-line px-3 py-1 text-sm" onclick={oncancel}>
          Cancel
        </button>
        <button
          type="submit"
          class="rounded bg-accent px-3 py-1 text-sm text-ink disabled:opacity-50"
          disabled={!name.trim()}
        >
          {confirmLabel}
        </button>
      </div>
    </form>
  </div>
</div>
