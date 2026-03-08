<template>
  <section class="hook-inbox-panel">
    <header class="hook-inbox-header">
      <div>
        <p class="hook-inbox-eyebrow">Hooks</p>
        <h2 class="hook-inbox-title">Pending hooks</h2>
        <p class="hook-inbox-subtitle">Review pending Codex App Server requests for the current server and jump to the affected thread.</p>
      </div>
      <span class="hook-inbox-count">{{ entries.length }}</span>
    </header>

    <p v-if="entries.length === 0" class="hook-inbox-empty">No pending hooks for this server.</p>

    <ul v-else class="hook-inbox-list">
      <li v-for="entry in entries" :key="`${entry.serverId}:${entry.requestId}`">
        <button class="hook-inbox-item" type="button" @click="$emit('open-thread', entry.threadId)">
          <span class="hook-inbox-item-top">
            <span class="hook-inbox-dot" />
            <span class="hook-inbox-thread">{{ entry.threadTitle }}</span>
          </span>
          <span class="hook-inbox-meta">{{ entry.projectName }} · {{ entry.method }}</span>
          <span class="hook-inbox-time">{{ formatReceivedAt(entry.receivedAtIso) }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { UiHookInboxEntry } from '../../types/codex'

const props = defineProps<{
  entries: UiHookInboxEntry[]
}>()

defineEmits<{
  (event: 'open-thread', threadId: string): void
}>()

function formatReceivedAt(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return value
  return parsed.toLocaleString()
}
</script>

<style scoped>
@reference "tailwindcss";

.hook-inbox-panel {
  @apply h-full overflow-auto px-4 pb-6 sm:px-6 flex flex-col gap-4;
}

.hook-inbox-header {
  @apply flex items-start justify-between gap-4;
}

.hook-inbox-eyebrow {
  @apply m-0 text-xs font-semibold uppercase tracking-[0.08em] text-red-700;
}

.hook-inbox-title {
  @apply mt-1 text-2xl font-semibold text-zinc-950;
}

.hook-inbox-subtitle {
  @apply mt-2 text-sm text-zinc-500;
}

.hook-inbox-count {
  @apply inline-flex min-h-8 min-w-8 items-center justify-center rounded-full bg-red-100 px-2.5 font-semibold text-red-700;
}

.hook-inbox-empty {
  @apply m-0 rounded-2xl bg-zinc-50 p-5 text-zinc-500;
}

.hook-inbox-list {
  @apply m-0 grid list-none gap-3 p-0;
}

.hook-inbox-item {
  @apply grid w-full gap-1.5 rounded-2xl border border-red-200 bg-white p-4 text-left transition hover:border-red-400 hover:shadow-[0_10px_30px_rgb(248_113_113_/0.12)];
}

.hook-inbox-item-top {
  @apply flex items-center gap-2.5;
}

.hook-inbox-dot {
  @apply h-2.5 w-2.5 flex-none rounded-full bg-red-600;
}

.hook-inbox-thread {
  @apply font-semibold text-zinc-950;
}

.hook-inbox-meta,
.hook-inbox-time {
  @apply text-sm text-zinc-500;
}
</style>
