<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { UpdateChannel } from '@shared/types'

  let {
    channel,
    busy,
    onCancel,
    onSave,
    onCheck
  }: {
    channel: UpdateChannel
    busy: boolean
    onCancel: () => void
    onSave: (channel: UpdateChannel) => void
    onCheck: (channel: UpdateChannel) => void
  } = $props()

  let picked = $state<UpdateChannel>(untrack(() => channel))

  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
  role="presentation"
  onclick={onCancel}
>
  <div
    class="w-full max-w-md rounded-xl border border-line bg-panel p-4 shadow-xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
  >
  <form
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault()
      onSave(picked)
    }}
  >
    <h2 class="text-sm font-medium">Settings</h2>
    <fieldset class="space-y-3">
      <legend class="mb-2 text-sm text-zinc-300">Updates</legend>
      <label class="flex items-start gap-2 text-sm">
        <input class="mt-1" type="radio" name="update-channel" value="stable" bind:group={picked} />
        <span>
          <span class="block">Stable</span>
          <span class="block text-xs text-zinc-400">Published releases only.</span>
        </span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input class="mt-1" type="radio" name="update-channel" value="rc" bind:group={picked} />
        <span>
          <span class="block">Release candidate</span>
          <span class="block text-xs text-zinc-400">Also offer rc builds, along with stable releases.</span>
        </span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input class="mt-1" type="radio" name="update-channel" value="beta" bind:group={picked} />
        <span>
          <span class="block">Beta</span>
          <span class="block text-xs text-zinc-400">Also offer beta and rc builds. A stable release of the same version is still newer.</span>
        </span>
      </label>
      <label class="flex items-start gap-2 text-sm">
        <input class="mt-1" type="radio" name="update-channel" value="off" bind:group={picked} />
        <span>
          <span class="block">Off</span>
          <span class="block text-xs text-zinc-400">Do not check for updates.</span>
        </span>
      </label>
    </fieldset>
    <div class="flex items-center justify-between gap-2 pt-1">
      <button
        class="rounded border border-line px-3 py-1 text-sm disabled:opacity-50"
        type="button"
        disabled={busy || picked === 'off'}
        title={picked === 'off' ? 'Choose a channel to check.' : undefined}
        onclick={() => onCheck(picked)}
      >
        Check for updates
      </button>
      <span class="flex gap-2">
        <button class="rounded border border-line px-3 py-1 text-sm" type="button" onclick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button class="rounded bg-accent px-3 py-1 text-sm text-ink disabled:opacity-50" type="submit" disabled={busy}>
          Save
        </button>
      </span>
    </div>
  </form>
  </div>
</div>
