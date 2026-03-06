<template>
  <section class="settings-panel">
    <header class="settings-panel-header">
      <div>
        <p class="settings-panel-eyebrow">Connectors</p>
        <h2 class="settings-panel-title">Connector control panel</h2>
        <p class="settings-panel-subtitle">
          Register outbound connectors for each remote Codex host and manage bootstrap, reinstall, and runtime status from one hub.
        </p>
      </div>
      <button type="button" class="settings-panel-refresh" :disabled="isLoading" @click="void refreshConnectors()">
        {{ isLoading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </header>

    <p v-if="errorMessage" class="settings-panel-error">{{ errorMessage }}</p>

    <div class="settings-grid">
      <form class="settings-card settings-create-card" @submit.prevent="void createConnector()">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">Create connector</h3>
            <p class="settings-card-subtitle">Create a per-user outbound connector and linked relay server entry.</p>
          </div>
        </div>

        <label class="settings-field">
          <span class="settings-field-label">Connector name</span>
          <input
            v-model="createForm.name"
            class="settings-field-input"
            type="text"
            name="connector-name"
            autocomplete="off"
            required
          />
        </label>

        <label class="settings-field">
          <span class="settings-field-label">Connector id</span>
          <input
            v-model="createForm.id"
            class="settings-field-input"
            type="text"
            name="connector-id"
            autocomplete="off"
            required
          />
        </label>

        <label class="settings-field">
          <span class="settings-field-label">Hub address</span>
          <input
            v-model="createForm.hubAddress"
            class="settings-field-input"
            type="url"
            name="connector-hub-address"
            autocomplete="off"
            placeholder="https://hub.example.com"
            required
          />
        </label>

        <button type="submit" class="settings-primary-button" :disabled="isCreating">
          {{ isCreating ? 'Creating…' : 'Create connector' }}
        </button>
      </form>

      <section class="settings-card settings-list-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">Registered connectors</h3>
            <p class="settings-card-subtitle">Each connector maps to one relay-backed server in the current user scope.</p>
          </div>
        </div>

        <ul v-if="connectors.length > 0" class="connector-list">
          <li v-for="connector in connectors" :key="connector.id">
            <button
              type="button"
              class="connector-list-item"
              :data-active="connector.id === selectedConnectorId"
              @click="selectedConnectorId = connector.id"
            >
              <span class="connector-list-row">
                <span class="connector-list-name">{{ connector.name }}</span>
                <span class="connector-status-pill" :data-state="statusPillTone(connector.installState)">
                  {{ formatInstallStateLabel(connector.installState) }}
                </span>
              </span>
              <span class="connector-list-meta">{{ connector.id }} · {{ connector.serverId }}</span>
            </button>
          </li>
        </ul>
        <div v-else class="settings-empty-state">
          No connectors registered yet.
        </div>
      </section>

      <section class="settings-card settings-detail-card">
        <template v-if="selectedConnector">
          <div class="settings-card-header">
            <div>
              <h3 class="settings-card-title">Connector details</h3>
              <p class="settings-card-subtitle">Lifecycle state, bootstrap metadata, and management actions for the selected connector.</p>
            </div>
          </div>

          <div class="settings-detail-grid">
            <label class="settings-field">
              <span class="settings-field-label">Current name</span>
              <input class="settings-field-input" type="text" :value="selectedConnector.name" readonly />
            </label>

            <label class="settings-field">
              <span class="settings-field-label">Selected ID</span>
              <input class="settings-field-input" type="text" :value="selectedConnector.id" readonly />
            </label>

            <label class="settings-field settings-field-wide">
              <span class="settings-field-label">Hub URL</span>
              <input class="settings-field-input" type="text" :value="selectedConnector.hubAddress" readonly />
            </label>

            <label class="settings-field">
              <span class="settings-field-label">Relay agent id</span>
              <input class="settings-field-input" type="text" :value="selectedConnector.relayAgentId" readonly />
            </label>

            <label class="settings-field">
              <span class="settings-field-label">Bound server id</span>
              <input class="settings-field-input" type="text" :value="selectedConnector.serverId" readonly />
            </label>
          </div>

          <div class="connector-summary-bar">
            <span class="connector-status-pill" :data-state="statusPillTone(selectedConnector.installState)">
              {{ formatInstallStateLabel(selectedConnector.installState) }}
            </span>
            <span>{{ selectedConnector.connected ? 'Transport online' : 'Transport offline' }}</span>
            <span>{{ formatProjectCount(selectedConnector) }}</span>
            <span>{{ formatThreadCount(selectedConnector) }}</span>
            <span v-if="selectedConnector.lastSeenAtIso">Last seen {{ formatDate(selectedConnector.lastSeenAtIso) }}</span>
            <span v-else>Last seen —</span>
          </div>

          <div class="settings-status-meta">
            <p v-if="selectedConnector.bootstrapIssuedAtIso">Bootstrap issued {{ formatDate(selectedConnector.bootstrapIssuedAtIso) }}</p>
            <p v-if="selectedConnector.bootstrapExpiresAtIso">Bootstrap expires {{ formatDate(selectedConnector.bootstrapExpiresAtIso) }}</p>
            <p v-if="selectedConnector.bootstrapConsumedAtIso">Bootstrap consumed {{ formatDate(selectedConnector.bootstrapConsumedAtIso) }}</p>
            <p v-if="selectedConnector.credentialIssuedAtIso">Credential issued {{ formatDate(selectedConnector.credentialIssuedAtIso) }}</p>
          </div>

          <div v-if="isRenaming" class="settings-inline-form">
            <label class="settings-field settings-inline-field">
              <span class="settings-field-label">Rename connector</span>
              <input v-model="renameDraft" class="settings-field-input" type="text" autocomplete="off" />
            </label>
            <div class="settings-inline-actions">
              <button type="button" class="settings-secondary-button" :disabled="isRenamingBusy" @click="cancelRename">
                Cancel
              </button>
              <button type="button" class="settings-primary-button" :disabled="isRenamingBusy" @click="void saveRename()">
                {{ isRenamingBusy ? 'Saving…' : 'Save name' }}
              </button>
            </div>
          </div>
          <div v-else class="settings-action-row">
            <button type="button" class="settings-secondary-button" @click="startRename">Edit name</button>
            <button type="button" class="settings-secondary-button" :disabled="isRotating" @click="void rotateToken()">
              {{ isRotating ? 'Reissuing…' : 'Reissue install token' }}
            </button>
            <button type="button" class="settings-danger-button" :disabled="isDeleting" @click="requestDelete">
              Delete connector
            </button>
            <button
              v-if="pendingDeleteConnectorId === selectedConnector.id"
              type="button"
              class="settings-danger-button"
              :disabled="isDeleting"
              @click="void confirmDelete()"
            >
              {{ isDeleting ? 'Deleting…' : 'Confirm delete' }}
            </button>
          </div>
        </template>
        <div v-else class="settings-empty-state">
          Select a connector to inspect status and actions.
        </div>
      </section>
    </div>

    <section v-if="selectedInstallArtifact" class="settings-card settings-install-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">Connector install artifact</h3>
          <p class="settings-card-subtitle">Reveal the one-time bootstrap token and install command for the selected connector.</p>
        </div>
      </div>

      <p class="settings-install-once">Bootstrap token is only shown once.</p>

      <label class="settings-field">
        <span class="settings-field-label">Bootstrap token</span>
        <div class="settings-inline-actions settings-inline-actions-tight">
          <button type="button" class="settings-secondary-button" @click="toggleTokenReveal">
            {{ isTokenRevealed ? 'Hide token' : 'Reveal token' }}
          </button>
        </div>
        <textarea
          class="settings-code-block"
          readonly
          :value="isTokenRevealed ? selectedInstallArtifact.token : '••••••••••••••••'"
        ></textarea>
        <p class="settings-field-help">
          Save this bootstrap token to a secure file on the connector host. The install step rewrites the same file with the durable credential.
        </p>
      </label>

      <label class="settings-field">
        <span class="settings-field-label">Suggested install command</span>
        <textarea class="settings-code-block settings-code-block-large" readonly :value="selectedInstallArtifact.command"></textarea>
      </label>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  createConnectorRegistration,
  deleteConnectorRegistration,
  getConnectorRegistrations,
  renameConnectorRegistration,
  rotateConnectorRegistrationToken,
  type CodexConnectorInfo,
} from '../../api/codexGateway'

const emit = defineEmits<{
  'connectors-changed': []
}>()

type InstallArtifact = {
  connectorId: string
  token: string
  command: string
}

const connectors = ref<CodexConnectorInfo[]>([])
const selectedConnectorId = ref('')
const isLoading = ref(false)
const isCreating = ref(false)
const isRenamingBusy = ref(false)
const isRotating = ref(false)
const isDeleting = ref(false)
const isRenaming = ref(false)
const isTokenRevealed = ref(false)
const errorMessage = ref('')
const renameDraft = ref('')
const pendingDeleteConnectorId = ref('')
const latestInstallArtifact = ref<InstallArtifact | null>(null)

const createForm = reactive({
  name: '',
  id: '',
  hubAddress: typeof window !== 'undefined' ? window.location.origin : '',
})

const selectedConnector = computed<CodexConnectorInfo | null>(() => {
  return connectors.value.find((connector) => connector.id === selectedConnectorId.value) ?? connectors.value[0] ?? null
})

const selectedInstallArtifact = computed<InstallArtifact | null>(() => {
  const artifact = latestInstallArtifact.value
  const connector = selectedConnector.value
  if (!artifact || !connector || artifact.connectorId !== connector.id) {
    return null
  }
  return artifact
})

function normalizeSelection(nextRows: CodexConnectorInfo[]): void {
  if (nextRows.length === 0) {
    selectedConnectorId.value = ''
    return
  }
  const current = selectedConnectorId.value.trim()
  if (current && nextRows.some((connector) => connector.id === current)) {
    return
  }
  selectedConnectorId.value = nextRows[0].id
}

function statusPillTone(state: CodexConnectorInfo['installState']): 'connected' | 'offline' | 'pending' | 'expired' | 'reinstall' {
  switch (state) {
    case 'connected':
      return 'connected'
    case 'offline':
      return 'offline'
    case 'expired_bootstrap':
      return 'expired'
    case 'reinstall_required':
      return 'reinstall'
    case 'pending_install':
    default:
      return 'pending'
  }
}

function formatInstallStateLabel(state: CodexConnectorInfo['installState']): string {
  switch (state) {
    case 'connected':
      return 'Connected'
    case 'offline':
      return 'Offline'
    case 'expired_bootstrap':
      return 'Expired bootstrap'
    case 'reinstall_required':
      return 'Reinstall required'
    case 'pending_install':
    default:
      return 'Pending install'
  }
}

function buildInstallCommand(connector: CodexConnectorInfo): string {
  const encodedHub = JSON.stringify(connector.hubAddress)
  const encodedConnectorId = JSON.stringify(connector.id)
  const encodedTokenFile = JSON.stringify(`$HOME/.codexui-connector/${connector.id}.token`)
  const parts = [
    'npx codexui-connector install',
    `--hub ${encodedHub}`,
    `--connector ${encodedConnectorId}`,
    `--token-file ${encodedTokenFile}`,
  ]
  if (connector.hubAddress.startsWith('http://')) {
    parts.push('--allow-insecure-http')
  }
  return parts.join(' ')
}

function setLatestInstallArtifact(connector: CodexConnectorInfo, token: string): void {
  latestInstallArtifact.value = {
    connectorId: connector.id,
    token,
    command: buildInstallCommand(connector),
  }
  isTokenRevealed.value = false
}

function toggleTokenReveal(): void {
  isTokenRevealed.value = !isTokenRevealed.value
}

function formatCount(value: number | undefined, singular: string, plural = `${singular}s`): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `— ${plural}`
  }
  return `${String(value)} ${value === 1 ? singular : plural}`
}

function formatProjectCount(connector: CodexConnectorInfo): string {
  return formatCount(connector.projectCount, 'project')
}

function formatThreadCount(connector: CodexConnectorInfo): string {
  return formatCount(connector.threadCount, 'thread')
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return '—'
  return parsed.toLocaleString()
}

function resetCreateForm(): void {
  createForm.name = ''
  createForm.id = ''
  createForm.hubAddress = typeof window !== 'undefined' ? window.location.origin : ''
}

async function refreshConnectors(): Promise<void> {
  isLoading.value = true
  errorMessage.value = ''
  try {
    const rows = await getConnectorRegistrations({ includeStats: true })
    connectors.value = rows
    normalizeSelection(rows)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load connectors'
    connectors.value = []
    selectedConnectorId.value = ''
  } finally {
    isLoading.value = false
  }
}

async function createConnector(): Promise<void> {
  if (isCreating.value) return
  isCreating.value = true
  errorMessage.value = ''
  try {
    const created = await createConnectorRegistration({
      id: createForm.id,
      name: createForm.name,
      hubAddress: createForm.hubAddress,
    })
    connectors.value = [created.connector, ...connectors.value]
    selectedConnectorId.value = created.connector.id
    latestInstallArtifact.value = null
    setLatestInstallArtifact(created.connector, created.bootstrapToken)
    pendingDeleteConnectorId.value = ''
    isRenaming.value = false
    emit('connectors-changed')
    resetCreateForm()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to create connector'
  } finally {
    isCreating.value = false
  }
}

function startRename(): void {
  const connector = selectedConnector.value
  if (!connector) return
  renameDraft.value = connector.name
  isRenaming.value = true
  pendingDeleteConnectorId.value = ''
}

function cancelRename(): void {
  isRenaming.value = false
  renameDraft.value = ''
}

async function saveRename(): Promise<void> {
  const connector = selectedConnector.value
  if (!connector || isRenamingBusy.value) return
  isRenamingBusy.value = true
  errorMessage.value = ''
  try {
    const renamed = await renameConnectorRegistration(connector.id, { name: renameDraft.value })
    connectors.value = connectors.value.map((entry) => (entry.id === connector.id ? renamed : entry))
    isRenaming.value = false
    renameDraft.value = ''
    emit('connectors-changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to rename connector'
  } finally {
    isRenamingBusy.value = false
  }
}

async function rotateToken(): Promise<void> {
  const connector = selectedConnector.value
  if (!connector || isRotating.value) return
  isRotating.value = true
  errorMessage.value = ''
  try {
    const rotated = await rotateConnectorRegistrationToken(connector.id)
    connectors.value = connectors.value.map((entry) => (entry.id === connector.id ? rotated.connector : entry))
    setLatestInstallArtifact(rotated.connector, rotated.bootstrapToken)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to reissue install token'
  } finally {
    isRotating.value = false
  }
}

function requestDelete(): void {
  const connector = selectedConnector.value
  if (!connector) return
  pendingDeleteConnectorId.value = connector.id
  isRenaming.value = false
}

async function confirmDelete(): Promise<void> {
  const connector = selectedConnector.value
  if (!connector || isDeleting.value || pendingDeleteConnectorId.value !== connector.id) return
  isDeleting.value = true
  errorMessage.value = ''
  try {
    await deleteConnectorRegistration(connector.id)
    await refreshConnectors()
    latestInstallArtifact.value = latestInstallArtifact.value?.connectorId === connector.id ? null : latestInstallArtifact.value
    if (latestInstallArtifact.value === null) {
      isTokenRevealed.value = false
    }
    pendingDeleteConnectorId.value = ''
    emit('connectors-changed')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to delete connector'
  } finally {
    isDeleting.value = false
  }
}

onMounted(() => {
  void refreshConnectors()
})
</script>

<style scoped>
@reference "tailwindcss";

.settings-panel {
  @apply h-full overflow-auto px-4 pb-6 sm:px-6 flex flex-col gap-4;
}

.settings-panel-header {
  @apply flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between;
}

.settings-panel-eyebrow {
  @apply m-0 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500;
}

.settings-panel-title {
  @apply m-0 text-2xl font-semibold text-zinc-950;
}

.settings-panel-subtitle {
  @apply m-0 mt-1 max-w-3xl text-sm leading-6 text-zinc-600;
}

.settings-panel-refresh {
  @apply rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60;
}

.settings-panel-error {
  @apply m-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700;
}

.settings-grid {
  @apply grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1.15fr)];
}

.settings-card {
  @apply rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm flex flex-col gap-4;
}

.settings-card-header {
  @apply flex items-start justify-between gap-3;
}

.settings-card-title {
  @apply m-0 text-base font-semibold text-zinc-950;
}

.settings-card-subtitle {
  @apply m-0 mt-1 text-sm leading-5 text-zinc-500;
}

.settings-field {
  @apply flex flex-col gap-1.5;
}

.settings-field-wide {
  @apply md:col-span-2;
}

.settings-field-label {
  @apply text-xs font-semibold uppercase tracking-[0.06em] text-zinc-500;
}

.settings-field-input {
  @apply h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-800 outline-none transition focus:border-zinc-400;
}

.settings-primary-button {
  @apply inline-flex items-center justify-center rounded-xl bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60;
}

.settings-secondary-button {
  @apply inline-flex items-center justify-center rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60;
}

.settings-danger-button {
  @apply inline-flex items-center justify-center rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60;
}

.connector-list {
  @apply m-0 flex list-none flex-col gap-2 p-0;
}

.connector-list-item {
  @apply w-full rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-left transition hover:border-zinc-300 hover:bg-zinc-100;
}

.connector-list-item[data-active='true'] {
  @apply border-zinc-900 bg-zinc-950 text-white;
}

.connector-list-item[data-active='true'] .connector-list-meta,
.connector-list-item[data-active='true'] .connector-list-stats {
  @apply text-zinc-200;
}

.connector-list-row {
  @apply flex items-center justify-between gap-3;
}

.connector-list-name {
  @apply text-sm font-semibold;
}

.connector-list-meta {
  @apply mt-1 block text-xs text-zinc-500;
}

.connector-list-stats {
  @apply mt-2 flex flex-wrap gap-3 text-xs text-zinc-600;
}

.connector-status-pill {
  @apply inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.05em];
}

.connector-status-pill[data-state='connected'] {
  @apply bg-emerald-100 text-emerald-700;
}

.connector-status-pill[data-state='offline'] {
  @apply bg-zinc-200 text-zinc-600;
}

.connector-status-pill[data-state='pending'] {
  @apply bg-amber-100 text-amber-700;
}

.connector-status-pill[data-state='expired'] {
  @apply bg-rose-100 text-rose-700;
}

.connector-status-pill[data-state='reinstall'] {
  @apply bg-violet-100 text-violet-700;
}

.settings-detail-grid {
  @apply grid grid-cols-1 gap-3 md:grid-cols-2;
}

.connector-summary-bar {
  @apply flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600;
}

.settings-status-meta {
  @apply flex flex-col gap-1 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm text-zinc-600;
}

.settings-status-meta p {
  @apply m-0;
}

.settings-inline-form {
  @apply flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-3;
}

.settings-inline-field {
  @apply w-full;
}

.settings-inline-actions,
.settings-action-row {
  @apply flex flex-wrap gap-2;
}

.settings-inline-actions-tight {
  @apply justify-start;
}

.settings-install-card {
  @apply mt-1;
}

.settings-install-once {
  @apply m-0 text-sm font-medium text-zinc-700;
}

.settings-code-block {
  @apply min-h-20 w-full rounded-2xl border border-zinc-200 bg-zinc-950 px-3 py-2 font-mono text-xs leading-6 text-zinc-50 outline-none resize-y;
}

.settings-code-block-large {
  @apply min-h-28;
}

.settings-empty-state {
  @apply rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-sm text-zinc-500;
}

.settings-field-help {
  @apply m-0 text-xs leading-5 text-zinc-500;
}
</style>
