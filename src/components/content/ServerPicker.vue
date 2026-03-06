<template>
  <div class="server-picker" :data-mode="mode" :data-tone="tone">
    <template v-if="mode === 'list'">
      <span class="server-picker-prefix">Servers</span>
      <div class="server-picker-chip-list">
        <button
          v-for="option in normalizedOptions"
          :key="option.id || option.label"
          class="server-picker-chip"
          type="button"
          :data-active="option.id === modelValue"
          :title="option.description || option.label"
          @click="onSelect(option.id)"
        >
          {{ option.label }}
        </button>
      </div>
    </template>
    <template v-else>
      <span class="server-picker-prefix">Server</span>
      <select
        v-if="normalizedOptions.length > 1"
        class="server-picker-select"
        :value="modelValue"
        @change="onChange"
      >
        <option
          v-for="option in normalizedOptions"
          :key="option.id || option.label"
          :value="option.id"
          :title="option.description || option.label"
        >
          {{ option.label }}
        </option>
      </select>
      <span v-else class="server-picker-static" :title="selectedDescription || selectedLabel">
        {{ selectedLabel }}
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type ServerPickerOption = {
  id: string
  label: string
  description?: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: ServerPickerOption[]
  mode?: 'compact' | 'list'
  tone?: 'default' | 'hero' | 'muted'
}>(), {
  mode: 'compact',
  tone: 'default',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const fallbackOption: ServerPickerOption = { id: '', label: 'Default server', description: '' }

const normalizedOptions = computed<ServerPickerOption[]>(() => {
  return props.options.length > 0 ? props.options : [fallbackOption]
})

const selectedOption = computed<ServerPickerOption>(() => {
  return normalizedOptions.value.find((option) => option.id === props.modelValue)
    ?? normalizedOptions.value[0]
    ?? fallbackOption
})

const selectedLabel = computed(() => selectedOption.value.label)
const selectedDescription = computed(() => selectedOption.value.description ?? '')

function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value ?? ''
  emit('update:modelValue', value)
}

function onSelect(value: string): void {
  emit('update:modelValue', value)
}
</script>

<style scoped>
@reference "tailwindcss";

.server-picker {
  @apply flex items-center gap-1.5 min-w-0;
}

.server-picker[data-mode='list'] {
  @apply flex-col items-start gap-2 w-full;
}

.server-picker-prefix {
  @apply text-[11px] uppercase tracking-[0.06em] text-zinc-400 shrink-0;
}

.server-picker[data-mode='list'] .server-picker-prefix {
  @apply text-xs tracking-[0.08em];
}

.server-picker[data-mode='list'][data-tone='hero'] .server-picker-prefix {
  @apply text-sm font-semibold tracking-[0.05em] text-zinc-950;
}

.server-picker[data-mode='list'][data-tone='muted'] .server-picker-prefix {
  @apply text-xs font-semibold text-zinc-400;
}

.server-picker-select {
  @apply max-w-[15rem] min-w-[7rem] h-7 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 outline-none transition focus:border-zinc-400;
}

.server-picker-static {
  @apply text-xs text-zinc-600 truncate;
}

.server-picker-chip-list {
  @apply w-full flex flex-wrap gap-2;
}

.server-picker-chip {
  @apply rounded-lg border px-3 py-1.5 transition;
}

.server-picker[data-mode='list'][data-tone='hero'] .server-picker-chip {
  @apply text-lg sm:text-xl font-bold text-zinc-950 border-zinc-300 bg-white hover:border-zinc-500 hover:bg-zinc-50;
}

.server-picker[data-mode='list'][data-tone='hero'] .server-picker-chip[data-active='true'] {
  @apply text-white bg-zinc-950 border-zinc-950;
}

.server-picker[data-mode='list'][data-tone='muted'] .server-picker-chip {
  @apply text-sm font-semibold text-zinc-500 border-zinc-300 bg-zinc-100 hover:text-zinc-600 hover:bg-zinc-200;
}

.server-picker[data-mode='list'][data-tone='muted'] .server-picker-chip[data-active='true'] {
  @apply text-zinc-700 border-zinc-400 bg-zinc-200;
}

.server-picker[data-mode='list'][data-tone='default'] .server-picker-chip {
  @apply text-sm font-medium text-zinc-700 border-zinc-300 bg-white hover:bg-zinc-100;
}

.server-picker[data-mode='list'][data-tone='default'] .server-picker-chip[data-active='true'] {
  @apply text-white bg-zinc-900 border-zinc-900;
}
</style>
