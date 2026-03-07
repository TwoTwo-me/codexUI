<template>
  <section class="admin-panel">
    <header class="admin-panel-header">
      <div>
        <h2 class="admin-panel-title">User Management</h2>
        <p class="admin-panel-subtitle">Review access requests, approve pending users, and manage Hub membership.</p>
      </div>
      <button type="button" class="admin-panel-refresh" :disabled="isLoading" @click="void refreshUsers()">
        {{ isLoading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </header>

    <p v-if="feedbackMessage" class="admin-panel-feedback">{{ feedbackMessage }}</p>
    <p v-if="errorMessage" class="admin-panel-error">{{ errorMessage }}</p>

    <div class="admin-panel-table-wrap">
      <table class="admin-panel-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Created</th>
            <th>Last Login</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td>{{ user.username }}</td>
            <td class="uppercase">{{ user.role }}</td>
            <td>
              <span class="approval-badge" :class="user.approvalStatus === 'approved' ? 'is-approved' : 'is-pending'">
                {{ user.approvalStatus === 'approved' ? 'Approved' : 'Pending approval' }}
              </span>
            </td>
            <td>{{ formatDate(user.createdAtIso) }}</td>
            <td>{{ formatDate(user.lastLoginAtIso) }}</td>
            <td>
              <button
                v-if="user.approvalStatus === 'pending'"
                type="button"
                class="approve-button"
                :disabled="pendingApprovalUserId === user.id"
                :aria-label="`Approve ${user.username}`"
                @click="void approvePendingUser(user)"
              >
                {{ pendingApprovalUserId === user.id ? `Approving ${user.username}…` : `Approve ${user.username}` }}
              </button>
              <span v-else class="text-zinc-400">—</span>
            </td>
          </tr>
          <tr v-if="users.length === 0">
            <td colspan="6" class="text-center py-6 text-zinc-500">No users found.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

type AdminUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  approvalStatus: 'approved' | 'pending'
  createdAtIso: string
  lastLoginAtIso?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function toUsers(payload: unknown): AdminUser[] {
  const root = asRecord(payload)
  const rows = Array.isArray(root?.data) ? root?.data : []
  const users: AdminUser[] = []
  for (const row of rows) {
    const record = asRecord(row)
    if (!record) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const username = typeof record.username === 'string' ? record.username.trim() : ''
    const role = record.role === 'admin' ? 'admin' : 'user'
    const approvalStatus = record.approvalStatus === 'pending' ? 'pending' : 'approved'
    const createdAtIso = typeof record.createdAtIso === 'string' ? record.createdAtIso : ''
    const lastLoginAtIso = typeof record.lastLoginAtIso === 'string' ? record.lastLoginAtIso : undefined
    if (!id || !username || !createdAtIso) continue
    users.push({ id, username, role, approvalStatus, createdAtIso, lastLoginAtIso })
  }
  return users
}

function formatDate(value?: string): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) return '—'
  return parsed.toLocaleString()
}

const users = ref<AdminUser[]>([])
const isLoading = ref(false)
const errorMessage = ref('')
const feedbackMessage = ref('')
const pendingApprovalUserId = ref('')

async function refreshUsers(): Promise<void> {
  isLoading.value = true
  errorMessage.value = ''
  try {
    const response = await fetch('/codex-api/admin/users')
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const fallback = `Failed to load users (${String(response.status)})`
      const message = asRecord(payload)?.error
      errorMessage.value = typeof message === 'string' && message.trim().length > 0 ? message : fallback
      users.value = []
      return
    }
    users.value = toUsers(payload)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load users'
    users.value = []
  } finally {
    isLoading.value = false
  }
}

async function approvePendingUser(user: AdminUser): Promise<void> {
  if (pendingApprovalUserId.value) return
  pendingApprovalUserId.value = user.id
  errorMessage.value = ''
  feedbackMessage.value = ''
  try {
    const response = await fetch(`/codex-api/admin/users/${encodeURIComponent(user.id)}/approve`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = asRecord(payload)?.error
      errorMessage.value = typeof message === 'string' && message.trim().length > 0
        ? message
        : `Failed to approve ${user.username}`
      return
    }
    feedbackMessage.value = `${user.username} approved successfully.`
    await refreshUsers()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `Failed to approve ${user.username}`
  } finally {
    pendingApprovalUserId.value = ''
  }
}

onMounted(() => {
  void refreshUsers()
})
</script>

<style scoped>
@reference "tailwindcss";

.admin-panel {
  @apply p-6 h-full overflow-auto flex flex-col gap-4;
}

.admin-panel-header {
  @apply flex items-start justify-between gap-3;
}

.admin-panel-title {
  @apply text-lg font-semibold text-zinc-900;
}

.admin-panel-subtitle {
  @apply text-sm text-zinc-500 mt-1;
}

.admin-panel-refresh {
  @apply rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 disabled:cursor-not-allowed;
}

.admin-panel-feedback {
  @apply text-sm text-emerald-600;
}

.admin-panel-error {
  @apply text-sm text-red-600;
}

.admin-panel-table-wrap {
  @apply rounded-lg border border-zinc-200 bg-white overflow-auto;
}

.admin-panel-table {
  @apply min-w-full text-sm;
}

.admin-panel-table thead th {
  @apply text-left font-medium text-zinc-600 bg-zinc-50 px-4 py-3 border-b border-zinc-200;
}

.admin-panel-table tbody td {
  @apply px-4 py-3 border-b border-zinc-100 text-zinc-700 align-middle;
}

.approval-badge {
  @apply inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium;
}

.approval-badge.is-approved {
  @apply bg-emerald-50 text-emerald-700;
}

.approval-badge.is-pending {
  @apply bg-amber-50 text-amber-700;
}

.approve-button {
  @apply rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60;
}
</style>
