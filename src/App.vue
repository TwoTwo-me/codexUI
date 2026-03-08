<template>
  <DesktopLayout :is-sidebar-collapsed="isSidebarCollapsed" @close-sidebar="setSidebarCollapsed(true)">
    <template #sidebar>
      <section class="sidebar-root">
        <SidebarThreadControls
          v-if="!isSidebarCollapsed"
          class="sidebar-thread-controls-host"
          :is-sidebar-collapsed="isSidebarCollapsed"
          :is-auto-refresh-enabled="isAutoRefreshEnabled"
          :auto-refresh-button-label="autoRefreshButtonLabel"
          :show-new-thread-button="true"
          @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
          @toggle-auto-refresh="onToggleAutoRefreshTimer"
          @start-new-thread="onStartNewThreadFromToolbar"
        >
          <button
            class="sidebar-search-toggle"
            type="button"
            :aria-pressed="isSidebarSearchVisible"
            aria-label="Search threads"
            title="Search threads"
            @click="toggleSidebarSearch"
          >
            <IconTablerSearch class="sidebar-search-toggle-icon" />
          </button>
        </SidebarThreadControls>

        <div v-if="!isSidebarCollapsed && isSidebarSearchVisible" class="sidebar-search-bar">
          <IconTablerSearch class="sidebar-search-bar-icon" />
          <input
            ref="sidebarSearchInputRef"
            v-model="sidebarSearchQuery"
            class="sidebar-search-input"
            type="text"
            placeholder="Filter threads..."
            @keydown="onSidebarSearchKeydown"
          />
          <button
            v-if="sidebarSearchQuery.length > 0"
            class="sidebar-search-clear"
            type="button"
            aria-label="Clear search"
            @click="clearSidebarSearch"
          >
            <IconTablerX class="sidebar-search-clear-icon" />
          </button>
        </div>

        <button
          v-if="!isSidebarCollapsed"
          class="sidebar-skills-link"
          :class="{ 'is-active': isSkillsRoute }"
          type="button"
          @click="router.push({ name: 'skills' }); isMobile && setSidebarCollapsed(true)"
        >
          Skills Hub
        </button>

        <button
          v-if="!isSidebarCollapsed"
          class="sidebar-skills-link"
          :class="{ 'is-active': isSettingsRoute }"
          type="button"
          @click="router.push({ name: 'settings' }); isMobile && setSidebarCollapsed(true)"
        >
          Settings
        </button>

        <button
          v-if="!isSidebarCollapsed"
          class="sidebar-skills-link"
          :class="{ 'is-active': isHooksRoute }"
          type="button"
          @click="router.push({ name: 'hooks' }); isMobile && setSidebarCollapsed(true)"
        >
          <span>Hooks</span>
          <span v-if="pendingHookCount > 0" class="sidebar-alert-badge">{{ pendingHookCount }}</span>
        </button>

        <button
          v-if="!isSidebarCollapsed && isAdminUser"
          class="sidebar-skills-link"
          :class="{ 'is-active': isAdminRoute }"
          type="button"
          @click="router.push({ name: 'admin' }); isMobile && setSidebarCollapsed(true)"
        >
          Admin
        </button>

        <SidebarThreadTree :groups="projectGroups" :project-display-name-by-id="projectDisplayNameById"
          v-if="!isSidebarCollapsed"
          :available-servers="availableServers"
          :selected-server-id="selectedServerId"
          :selected-thread-id="selectedThreadId" :is-loading="isLoadingThreads"
          :search-query="sidebarSearchQuery"
          :has-pending-hooks="hasPendingHooks"
          :hook-count-by-project-name="hookCountByProjectName"
          :hook-count-by-thread-id="hookCountByThreadId"
          @select-server="onSelectServer"
          @select="onSelectThread"
          @archive="onArchiveThread" @start-new-thread="onStartNewThread" @rename-project="onRenameProject"
          @remove-project="onRemoveProject" @reorder-project="onReorderProject" />
      </section>
    </template>

    <template #content>
        <section class="content-root">
          <ContentHeader :title="contentTitle">
            <template #leading>
            <SidebarThreadControls
              v-if="isSidebarCollapsed || isMobile"
              class="sidebar-thread-controls-header-host"
              :is-sidebar-collapsed="isSidebarCollapsed"
              :is-auto-refresh-enabled="isAutoRefreshEnabled"
              :auto-refresh-button-label="autoRefreshButtonLabel"
              :show-new-thread-button="true"
              @toggle-sidebar="setSidebarCollapsed(!isSidebarCollapsed)"
              @toggle-auto-refresh="onToggleAutoRefreshTimer"
                @start-new-thread="onStartNewThreadFromToolbar"
            />
          </template>
          <template #meta>
            <div class="header-meta-stack">
              <div class="header-session-row">
                <span class="header-session-identity">
                  {{ sessionLabel }}
                </span>
                <button
                  type="button"
                  class="header-session-logout"
                  :disabled="isLoggingOut"
                  @click="void onLogout()"
                >
                  {{ isLoggingOut ? 'Signing out…' : 'Sign out' }}
                </button>
              </div>
              <ServerPicker
                v-if="(isHomeRoute && hasRegisteredServers) || isThreadRoute"
                :model-value="selectedServerId"
                :options="availableServers"
                mode="compact"
                :disabled="isThreadRoute"
                @update:model-value="onSelectServer"
              />
              <p v-if="isThreadRoute" class="header-thread-subtitle">{{ threadHeaderTitle }}</p>
              <CwdPicker v-if="isHomeRoute && hasRegisteredServers" v-model="newThreadCwd" />
            </div>
          </template>
        </ContentHeader>

        <section class="content-body">
          <template v-if="isSkillsRoute">
            <SkillsHub @skills-changed="onSkillsChanged" />
          </template>
          <template v-else-if="isAdminRoute">
            <AdminPanel v-if="isAdminUser" />
            <section v-else class="admin-guard">
              <h2 class="admin-guard-title">Admin access required</h2>
              <p class="admin-guard-subtitle">This page is only available to administrator accounts.</p>
            </section>
          </template>
          <template v-else-if="isSettingsRoute">
            <SettingsPanel @connectors-changed="onConnectorsChanged" />
          </template>
          <template v-else-if="isHooksRoute">
            <HookInboxPanel :entries="hookInboxEntries" @open-thread="onOpenHookThread" />
          </template>
          <template v-else-if="isHomeRoute">
            <div class="content-grid">
              <template v-if="hasRegisteredServers">
                <div class="new-thread-empty">
                  <p class="new-thread-hero">New thread</p>
                </div>

                <ThreadComposer :active-thread-id="composerThreadContextId"
                  :cwd="composerCwd"
                  :models="availableModelIds" :selected-model="selectedModelId"
                  :selected-reasoning-effort="selectedReasoningEffort" :skills="installedSkills"
                  :is-turn-in-progress="false"
                  :is-interrupting-turn="false" @submit="onSubmitThreadMessage"
                  @update:selected-model="onSelectModel" @update:selected-reasoning-effort="onSelectReasoningEffort" />
              </template>
              <section v-else class="registration-empty-state">
                <p class="registration-empty-eyebrow">Server registration required</p>
                <h2 class="registration-empty-title">Register a server to start a thread</h2>
                <p class="registration-empty-body">
                  Local folders stay unavailable until you explicitly register a server or connector.
                </p>
              </section>
            </div>
          </template>
          <template v-else>
            <div class="content-grid">
              <div class="content-thread">
                <ThreadConversation :messages="filteredMessages" :is-loading="isLoadingMessages"
                  :active-thread-id="composerThreadContextId" :scroll-state="selectedThreadScrollState"
                  :live-overlay="liveOverlay"
                  :pending-requests="selectedThreadServerRequests"
                  :is-turn-in-progress="isSelectedThreadInProgress"
                  :is-rolling-back="isRollingBack"
                  @update-scroll-state="onUpdateThreadScrollState"
                  @respond-server-request="onRespondServerRequest"
                  @rollback="onRollback" />
              </div>

              <div class="composer-with-queue">
                <QueuedMessages
                  :messages="selectedThreadQueuedMessages"
                  @steer="steerQueuedMessage"
                  @delete="removeQueuedMessage"
                />
                <ThreadComposer :active-thread-id="composerThreadContextId"
                  :cwd="composerCwd"
                  :models="availableModelIds"
                  :selected-model="selectedModelId" :selected-reasoning-effort="selectedReasoningEffort"
                  :skills="installedSkills"
                  :is-turn-in-progress="isSelectedThreadInProgress" :is-interrupting-turn="isInterruptingTurn"
                  :has-queue-above="selectedThreadQueuedMessages.length > 0"
                  @submit="onSubmitThreadMessage" @update:selected-model="onSelectModel"
                  @update:selected-reasoning-effort="onSelectReasoningEffort" @interrupt="onInterruptTurn" />
              </div>
            </div>
          </template>
        </section>
      </section>
    </template>
  </DesktopLayout>
  <div class="build-badge" aria-label="Worktree name">
    WT {{ worktreeName }}
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DesktopLayout from './components/layout/DesktopLayout.vue'
import SidebarThreadTree from './components/sidebar/SidebarThreadTree.vue'
import ContentHeader from './components/content/ContentHeader.vue'
import ThreadConversation from './components/content/ThreadConversation.vue'
import ThreadComposer from './components/content/ThreadComposer.vue'
import QueuedMessages from './components/content/QueuedMessages.vue'
import CwdPicker from './components/content/CwdPicker.vue'
import ServerPicker from './components/content/ServerPicker.vue'
import SkillsHub from './components/content/SkillsHub.vue'
import AdminPanel from './components/content/AdminPanel.vue'
import SettingsPanel from './components/content/SettingsPanel.vue'
import HookInboxPanel from './components/content/HookInboxPanel.vue'
import SidebarThreadControls from './components/sidebar/SidebarThreadControls.vue'
import IconTablerSearch from './components/icons/IconTablerSearch.vue'
import IconTablerX from './components/icons/IconTablerX.vue'
import { useDesktopState } from './composables/useDesktopState'
import { useMobile } from './composables/useMobile'
import type { ReasoningEffort, ThreadScrollState } from './types/codex'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-web-local.sidebar-collapsed.v1'
const worktreeName = import.meta.env.VITE_WORKTREE_NAME ?? 'unknown'

const {
  availableServers,
  selectedServerId,
  selectServer,
  projectGroups,
  projectDisplayNameById,
  selectedThread,
  selectedThreadScrollState,
  selectedThreadServerRequests,
  hookInboxEntries,
  hookCountByProjectName,
  hookCountByThreadId,
  hasPendingHooks,
  pendingHookCount,
  selectedLiveOverlay,
  selectedThreadId,
  availableModelIds,
  selectedModelId,
  selectedReasoningEffort,
  installedSkills,
  messages,
  isLoadingThreads,
  isLoadingMessages,
  isSendingMessage,
  isInterruptingTurn,
  isAutoRefreshEnabled,
  autoRefreshSecondsLeft,
  refreshAll,
  refreshSkills,
  selectThread,
  setThreadScrollState,
  archiveThreadById,
  sendMessageToSelectedThread,
  sendMessageToNewThread,
  interruptSelectedThreadTurn,
  rollbackSelectedThread,
  isRollingBack,
  selectedThreadQueuedMessages,
  removeQueuedMessage,
  steerQueuedMessage,
  setSelectedModelId,
  setSelectedReasoningEffort,
  respondToPendingServerRequest,
  renameProject,
  removeProject,
  reorderProject,
  toggleAutoRefreshTimer,
  startPolling,
  stopPolling,
} = useDesktopState()

const route = useRoute()
const router = useRouter()
const { isMobile } = useMobile()
const isRouteSyncInProgress = ref(false)
const hasInitialized = ref(false)
const newThreadCwd = ref('~')
const isSidebarCollapsed = ref(loadSidebarCollapsed())
const sidebarSearchQuery = ref('')
const isSidebarSearchVisible = ref(false)
const sidebarSearchInputRef = ref<HTMLInputElement | null>(null)

const routeThreadId = computed(() => {
  const rawThreadId = route.params.threadId
  return typeof rawThreadId === 'string' ? rawThreadId : ''
})

const knownThreadIdSet = computed(() => {
  const ids = new Set<string>()
  for (const group of projectGroups.value) {
    for (const thread of group.threads) {
      ids.add(thread.id)
    }
  }
  return ids
})

const isHomeRoute = computed(() => route.name === 'home')
const isSkillsRoute = computed(() => route.name === 'skills')
const isAdminRoute = computed(() => route.name === 'admin')
const isSettingsRoute = computed(() => route.name === 'settings')
const isHooksRoute = computed(() => route.name === 'hooks')
const isThreadRoute = computed(() => route.name === 'thread')
type SessionUser = {
  id: string
  username: string
  role: 'admin' | 'user'
}
const sessionUser = ref<SessionUser | null>(null)
const isLoggingOut = ref(false)
const isAdminUser = computed(() => sessionUser.value?.role === 'admin')
const hasRegisteredServers = computed(() => availableServers.value.length > 0)
const sessionLabel = computed(() => {
  const user = sessionUser.value
  if (!user) return 'Guest'
  return `${user.username} (${user.role})`
})
const selectedServerLabel = computed(() => {
  const selectedId = selectedServerId.value
  const selected = availableServers.value.find((server) => server.id === selectedId)
  if (selected) return selected.label
  return availableServers.value[0]?.label ?? 'No server registered'
})
const selectedProjectLabel = computed(() => {
  const thread = selectedThread.value
  if (!thread) return '~'
  const projectName = thread.projectName?.trim() ?? ''
  if (!projectName) return '~'
  return projectDisplayNameById.value[projectName] ?? projectName
})
const contentTitle = computed(() => {
  if (isSkillsRoute.value) return 'Skills'
  if (isAdminRoute.value) return 'Admin'
  if (isSettingsRoute.value) return 'Settings'
  if (isHooksRoute.value) return 'Hooks'
  if (isHomeRoute.value) return 'New thread'
  return `${selectedServerLabel.value} / ${selectedProjectLabel.value}`
})
const threadHeaderTitle = computed(() => selectedThread.value?.title ?? 'Choose a thread')
const autoRefreshButtonLabel = computed(() =>
  isAutoRefreshEnabled.value
    ? `Auto refresh in ${String(autoRefreshSecondsLeft.value)}s`
    : 'Enable 4s refresh',
)
const filteredMessages = computed(() =>
  messages.value.filter((message) => {
    const type = normalizeMessageType(message.messageType, message.role)
    if (type === 'worked') return true
    if (type === 'turnActivity.live' || type === 'turnError.live' || type === 'agentReasoning.live') return false
    return true
  }),
)
const liveOverlay = computed(() => selectedLiveOverlay.value)
const composerThreadContextId = computed(() => (isHomeRoute.value ? '__new-thread__' : selectedThreadId.value))
const composerCwd = computed(() => {
  if (isHomeRoute.value) return newThreadCwd.value.trim()
  return selectedThread.value?.cwd?.trim() ?? ''
})
const isSelectedThreadInProgress = computed(() => !isHomeRoute.value && selectedThread.value?.inProgress === true)
onMounted(() => {
  window.addEventListener('keydown', onWindowKeyDown)
  void initialize()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeyDown)
  stopPolling()
})

function onSkillsChanged(): void {
  void refreshSkills()
}

function onConnectorsChanged(): void {
  void refreshAll()
}

function toggleSidebarSearch(): void {
  isSidebarSearchVisible.value = !isSidebarSearchVisible.value
  if (isSidebarSearchVisible.value) {
    nextTick(() => sidebarSearchInputRef.value?.focus())
  } else {
    sidebarSearchQuery.value = ''
  }
}

function clearSidebarSearch(): void {
  sidebarSearchQuery.value = ''
  sidebarSearchInputRef.value?.focus()
}

function onSidebarSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    isSidebarSearchVisible.value = false
    sidebarSearchQuery.value = ''
  }
}

function onSelectThread(threadId: string): void {
  if (!threadId) return
  if (route.name === 'thread' && routeThreadId.value === threadId) return
  void router.push({ name: 'thread', params: { threadId } })
  if (isMobile.value) setSidebarCollapsed(true)
}

function onArchiveThread(threadId: string): void {
  void archiveThreadById(threadId)
}

function onStartNewThread(_projectName: string): void {
  newThreadCwd.value = '~'
  if (isMobile.value) setSidebarCollapsed(true)
  if (isHomeRoute.value) return
  void router.push({ name: 'home' })
}

function onStartNewThreadFromToolbar(): void {
  newThreadCwd.value = '~'
  if (isMobile.value) setSidebarCollapsed(true)
  if (isHomeRoute.value) return
  void router.push({ name: 'home' })
}

function onRenameProject(payload: { projectName: string; displayName: string }): void {
  renameProject(payload.projectName, payload.displayName)
}

function onRemoveProject(projectName: string): void {
  removeProject(projectName)
}

function onReorderProject(payload: { projectName: string; toIndex: number }): void {
  reorderProject(payload.projectName, payload.toIndex)
}

function onUpdateThreadScrollState(payload: { threadId: string; state: ThreadScrollState }): void {
  setThreadScrollState(payload.threadId, payload.state)
}

function onRespondServerRequest(payload: { id: number; result?: unknown; error?: { code?: number; message: string } }): void {
  void respondToPendingServerRequest(payload)
}

function onToggleAutoRefreshTimer(): void {
  toggleAutoRefreshTimer()
}

function onSelectServer(serverId: string): void {
  if (isHomeRoute.value) {
    newThreadCwd.value = '~'
  }
  void selectServer(serverId)
}

function onOpenHookThread(threadId: string): void {
  if (!threadId) return
  void router.push({ name: 'thread', params: { threadId } })
  if (isMobile.value) setSidebarCollapsed(true)
}

function setSidebarCollapsed(nextValue: boolean): void {
  if (isSidebarCollapsed.value === nextValue) return
  isSidebarCollapsed.value = nextValue
  saveSidebarCollapsed(nextValue)
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (!event.ctrlKey && !event.metaKey) return
  if (event.shiftKey || event.altKey) return
  if (event.key.toLowerCase() !== 'b') return
  event.preventDefault()
  setSidebarCollapsed(!isSidebarCollapsed.value)
}

function onSubmitThreadMessage(payload: { text: string; imageUrls: string[]; fileAttachments: Array<{ label: string; path: string; fsPath: string }>; skills: Array<{ name: string; path: string }>; mode: 'steer' | 'queue' }): void {
  const text = payload.text
  if (isHomeRoute.value) {
    void submitFirstMessageForNewThread(text, payload.imageUrls, payload.skills, payload.fileAttachments)
    return
  }
  void sendMessageToSelectedThread(text, payload.imageUrls, payload.skills, payload.mode, payload.fileAttachments)
}

function onSelectModel(modelId: string): void {
  setSelectedModelId(modelId)
}

function onSelectReasoningEffort(effort: ReasoningEffort | ''): void {
  setSelectedReasoningEffort(effort)
}

function onInterruptTurn(): void {
  void interruptSelectedThreadTurn()
}

function onRollback(payload: { turnIndex: number }): void {
  void rollbackSelectedThread(payload.turnIndex)
}

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
}

function saveSidebarCollapsed(value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, value ? '1' : '0')
}

function normalizeMessageType(rawType: string | undefined, role: string): string {
  const normalized = (rawType ?? '').trim()
  if (normalized.length > 0) {
    return normalized
  }
  return role.trim() || 'message'
}

async function initialize(): Promise<void> {
  await refreshSessionUser()
  await refreshAll()
  hasInitialized.value = true
  await syncThreadSelectionWithRoute()
  startPolling()
}

async function syncThreadSelectionWithRoute(): Promise<void> {
  if (isRouteSyncInProgress.value) return
  isRouteSyncInProgress.value = true

  try {
    if (route.name === 'home' || route.name === 'skills' || route.name === 'settings' || route.name === 'hooks') {
      if (selectedThreadId.value !== '') {
        await selectThread('')
      }
      return
    }

    if (route.name === 'admin') {
      if (!isAdminUser.value) {
        await router.replace({ name: 'home' })
        return
      }
      if (selectedThreadId.value !== '') {
        await selectThread('')
      }
      return
    }

    if (route.name === 'thread') {
      const threadId = routeThreadId.value
      if (!threadId) return

      if (!knownThreadIdSet.value.has(threadId)) {
        await router.replace({ name: 'home' })
        return
      }

      if (selectedThreadId.value !== threadId) {
        await selectThread(threadId)
      }
      return
    }

  } finally {
    isRouteSyncInProgress.value = false
  }
}

watch(
  () =>
    [
      route.name,
      routeThreadId.value,
      isLoadingThreads.value,
      knownThreadIdSet.value.has(routeThreadId.value),
      selectedThreadId.value,
      isAdminUser.value,
    ] as const,
  async () => {
    if (!hasInitialized.value) return
    await syncThreadSelectionWithRoute()
  },
)

watch(
  () => selectedThreadId.value,
  async (threadId) => {
    if (!hasInitialized.value) return
    if (isRouteSyncInProgress.value) return
    if (isHomeRoute.value || isSkillsRoute.value || isAdminRoute.value || isSettingsRoute.value || isHooksRoute.value) return

    if (!threadId) {
      if (route.name !== 'home') {
        await router.replace({ name: 'home' })
      }
      return
    }

    if (route.name === 'thread' && routeThreadId.value === threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  },
)

watch(isMobile, (mobile) => {
  if (mobile && !isSidebarCollapsed.value) {
    setSidebarCollapsed(true)
  }
})

async function submitFirstMessageForNewThread(
  text: string,
  imageUrls: string[] = [],
  skills: Array<{ name: string; path: string }> = [],
  fileAttachments: Array<{ label: string; path: string; fsPath: string }> = [],
): Promise<void> {
  try {
    const threadId = await sendMessageToNewThread(text, newThreadCwd.value, imageUrls, skills, fileAttachments)
    if (!threadId) return
    await router.replace({ name: 'thread', params: { threadId } })
  } catch {
    // Error is already reflected in state.
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function refreshSessionUser(): Promise<void> {
  try {
    const response = await fetch('/auth/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    const payload = await response.json().catch(() => ({}))
    const root = asRecord(payload)
    const rawUser = asRecord(root?.user)
    const authenticated = root?.authenticated === true

    if (!response.ok || !authenticated || !rawUser) {
      sessionUser.value = null
      return
    }

    const id = typeof rawUser.id === 'string' ? rawUser.id.trim() : ''
    const username = typeof rawUser.username === 'string' ? rawUser.username.trim() : ''
    const role = rawUser.role === 'admin' ? 'admin' : 'user'
    if (!id || !username) {
      sessionUser.value = null
      return
    }
    sessionUser.value = { id, username, role }
  } catch {
    sessionUser.value = null
  }
}

async function onLogout(): Promise<void> {
  if (isLoggingOut.value) return
  isLoggingOut.value = true
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
  } finally {
    sessionUser.value = null
    isLoggingOut.value = false
    window.location.reload()
  }
}
</script>

<style scoped>
@reference "tailwindcss";

.sidebar-root {
  @apply min-h-full py-4 px-2 flex flex-col gap-2 select-none;
}

.sidebar-root input,
.sidebar-root textarea {
  @apply select-text;
}

.content-root {
  @apply h-full min-h-0 w-full flex flex-col overflow-y-hidden overflow-x-visible bg-white;
}

.sidebar-thread-controls-host {
  @apply mt-1 -translate-y-px px-2 pb-1;
}

.sidebar-search-toggle {
  @apply h-6.75 w-6.75 rounded-md border border-transparent bg-transparent text-zinc-600 flex items-center justify-center transition hover:border-zinc-200 hover:bg-zinc-50;
}

.sidebar-search-toggle[aria-pressed='true'] {
  @apply border-zinc-300 bg-zinc-100 text-zinc-700;
}

.sidebar-search-toggle-icon {
  @apply w-4 h-4;
}

.sidebar-search-bar {
  @apply flex items-center gap-1.5 mx-2 px-2 py-1 rounded-md border border-zinc-200 bg-white transition-colors focus-within:border-zinc-400;
}

.sidebar-search-bar-icon {
  @apply w-3.5 h-3.5 text-zinc-400 shrink-0;
}

.sidebar-search-input {
  @apply flex-1 min-w-0 bg-transparent text-sm text-zinc-800 placeholder-zinc-400 outline-none border-none p-0;
}

.sidebar-search-clear {
  @apply w-4 h-4 rounded text-zinc-400 flex items-center justify-center transition hover:text-zinc-600;
}

.sidebar-search-clear-icon {
  @apply w-3.5 h-3.5;
}

.sidebar-skills-link {
  @apply mx-2 flex items-center rounded-lg border-0 bg-transparent px-2 py-1.5 text-sm text-zinc-600 transition hover:bg-zinc-200 hover:text-zinc-900 cursor-pointer;
}

.sidebar-skills-link.is-active {
  @apply bg-zinc-200 text-zinc-900 font-medium;
}

.sidebar-alert-badge {
  @apply ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 py-0.5 text-[11px] font-semibold text-white;
}

.sidebar-thread-controls-header-host {
  @apply ml-1;
}

.header-cwd-readonly {
  @apply m-0 max-w-full truncate text-xs text-zinc-500;
}

.header-meta-stack {
  @apply min-w-0 flex flex-col gap-1;
}

.header-thread-subtitle {
  @apply m-0 text-sm font-semibold text-zinc-800 truncate;
}

.header-session-row {
  @apply min-w-0 flex items-center justify-end gap-2;
}

.header-session-identity {
  @apply text-xs text-zinc-600 truncate;
}

.header-session-logout {
  @apply rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-60 disabled:cursor-not-allowed;
}

.content-body {
  @apply flex-1 min-h-0 w-full flex flex-col gap-2 sm:gap-3 pt-1 pb-2 sm:pb-4 overflow-y-hidden overflow-x-visible;
}

.content-error {
  @apply m-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700;
}

.content-grid {
  @apply flex-1 min-h-0 flex flex-col gap-3;
}

.content-thread {
  @apply flex-1 min-h-0;
}

.composer-with-queue {
  @apply w-full;
}

.new-thread-empty {
  @apply flex-1 min-h-0 flex flex-col items-center justify-center gap-0.5 px-3 sm:px-6;
}

.new-thread-hero {
  @apply m-0 text-2xl sm:text-[2.5rem] font-semibold leading-[1.05] text-zinc-900;
}

.registration-empty-state {
  @apply flex-1 min-h-0 mx-3 sm:mx-6 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-5 py-8 sm:px-8 sm:py-10 flex flex-col items-start justify-center gap-3;
}

.registration-empty-eyebrow {
  @apply m-0 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500;
}

.registration-empty-title {
  @apply m-0 text-2xl sm:text-3xl font-semibold text-zinc-950;
}

.registration-empty-body {
  @apply m-0 max-w-2xl text-sm sm:text-base leading-6 text-zinc-600;
}

.admin-guard {
  @apply h-full w-full flex flex-col items-center justify-center gap-2 text-center px-4;
}

.admin-guard-title {
  @apply m-0 text-lg font-semibold text-zinc-900;
}

.admin-guard-subtitle {
  @apply m-0 text-sm text-zinc-500;
}

.build-badge {
  @apply fixed top-3 right-3 z-50 rounded-md border border-zinc-200 bg-white/95 px-2 py-1 text-xs font-medium text-zinc-600 shadow-sm backdrop-blur;
}

</style>
