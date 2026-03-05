import type { IncomingMessage } from 'node:http'
import type { UserProfile } from './userStore.js'

type RequestWithAuthContext = IncomingMessage & {
  codexAuthUser?: UserProfile | null
}

export function setRequestAuthenticatedUser(req: IncomingMessage, user: UserProfile | null): void {
  const scopedReq = req as RequestWithAuthContext
  scopedReq.codexAuthUser = user
}

export function getRequestAuthenticatedUser(req: IncomingMessage): UserProfile | null {
  const value = (req as RequestWithAuthContext).codexAuthUser
  return value ?? null
}

export function getRequestAuthScopeKey(req: IncomingMessage): string {
  const user = getRequestAuthenticatedUser(req)
  if (!user) return 'global'
  return `user:${user.id}`
}
