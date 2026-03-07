import {
  RELAY_PROTOCOL,
  RELAY_PROTOCOL_VERSION,
  type RelayEventEnvelope,
  type RelayRequestEnvelope,
  type RelayResponseEnvelope,
} from '../types/relayProtocol.js'
import {
  RELAY_E2EE_RPC_METHOD,
  normalizeRelayE2eeEnvelope,
} from '../types/relayE2ee.js'
import {
  decryptRelayE2eePayload,
  encryptRelayE2eePayload,
} from '../utils/relayE2eeCrypto.js'

export type RelayConnectorNotification = {
  method: string
  params: unknown
}

export type RelayConnectorAppServer = {
  rpc(method: string, params: unknown): Promise<unknown>
  onNotification(listener: (notification: RelayConnectorNotification) => void): () => void
  dispose?(): void
}

export type RelayConnectorSession = {
  sessionId: string
  pollTimeoutMs?: number
}

export type RelayConnectorTransport = {
  connect(token: string): Promise<RelayConnectorSession>
  pull(token: string, sessionId: string, waitMs?: number): Promise<RelayRequestEnvelope[]>
  push(token: string, sessionId: string, messages: Array<RelayResponseEnvelope | RelayEventEnvelope>): Promise<void>
}

export type RelayConnectorE2eeConfig = {
  keyId: string
  passphrase: string
}

export type RelayConnectorLogLevel = 'info' | 'warn' | 'error' | 'debug'

export type RelayConnectorOptions = {
  token: string
  transport: RelayConnectorTransport
  appServer: RelayConnectorAppServer
  connectorId?: string
  relayE2ee?: RelayConnectorE2eeConfig
  pollWaitMs?: number
  reconnectDelayMs?: number
  notificationFlushDelayMs?: number
  onLog?: (level: RelayConnectorLogLevel, message: string) => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function asRateLimitError(error: unknown): { message: string; retryAfterMs?: number } | null {
  if (!(error instanceof Error)) return null
  const statusCode = (error as Error & { statusCode?: unknown }).statusCode
  if (statusCode !== 429) return null
  const retryAfterMs = (error as Error & { retryAfterMs?: unknown }).retryAfterMs
  return {
    message: error.message,
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { retryAfterMs }
      : {}),
  }
}

export class CodexRelayConnector {
  private readonly token: string
  private readonly transport: RelayConnectorTransport
  private readonly appServer: RelayConnectorAppServer
  private readonly relayE2ee?: RelayConnectorE2eeConfig
  private readonly pollWaitMs: number
  private readonly reconnectDelayMs: number
  private readonly notificationFlushDelayMs: number
  private readonly connectorId: string
  private readonly onLog?: (level: RelayConnectorLogLevel, message: string) => void
  private readonly pendingMessages: Array<RelayResponseEnvelope | RelayEventEnvelope> = []
  private readonly unsubscribeNotificationListener: () => void
  private flushPromise: Promise<void> | null = null
  private notificationFlushTimer: ReturnType<typeof setTimeout> | null = null
  private sessionId = ''
  private activeRoute: RelayRequestEnvelope['route'] | null = null
  private stopped = false

  constructor(options: RelayConnectorOptions) {
    this.token = options.token.trim()
    this.transport = options.transport
    this.appServer = options.appServer
    this.relayE2ee = options.relayE2ee
    this.pollWaitMs = typeof options.pollWaitMs === 'number' && Number.isFinite(options.pollWaitMs)
      ? Math.max(0, Math.trunc(options.pollWaitMs))
      : 25_000
    this.reconnectDelayMs = typeof options.reconnectDelayMs === 'number' && Number.isFinite(options.reconnectDelayMs)
      ? Math.max(1_000, Math.trunc(options.reconnectDelayMs))
      : 3_000
    this.notificationFlushDelayMs = typeof options.notificationFlushDelayMs === 'number' && Number.isFinite(options.notificationFlushDelayMs)
      ? Math.max(0, Math.trunc(options.notificationFlushDelayMs))
      : 250
    this.connectorId = options.connectorId?.trim() || 'connector'
    this.onLog = options.onLog
    this.unsubscribeNotificationListener = this.appServer.onNotification((notification) => {
      void this.handleLocalNotification(notification)
    })
  }

  async connect(): Promise<RelayConnectorSession> {
    const session = await this.transport.connect(this.token)
    this.sessionId = session.sessionId.trim()
    this.log('info', `Connected ${this.connectorId} with session ${this.sessionId}`)
    return session
  }

  async pollOnce(): Promise<void> {
    if (!this.sessionId) {
      await this.connect()
    }
    const messages = await this.transport.pull(this.token, this.sessionId, this.pollWaitMs)
    for (const message of messages) {
      await this.processRequestEnvelope(message)
    }
    await this.flushPendingMessages()
  }

  async flushPendingMessages(): Promise<void> {
    if (this.notificationFlushTimer) {
      clearTimeout(this.notificationFlushTimer)
      this.notificationFlushTimer = null
    }

    if (!this.sessionId || this.pendingMessages.length === 0) {
      return
    }

    if (this.flushPromise) {
      await this.flushPromise
      return
    }

    this.flushPromise = (async () => {
      while (this.pendingMessages.length > 0) {
        const batch = this.pendingMessages.splice(0, this.pendingMessages.length)
        try {
          await this.transport.push(this.token, this.sessionId, batch)
        } catch (error) {
          this.pendingMessages.unshift(...batch)
          throw error
        }
      }
    })().finally(() => {
      this.flushPromise = null
    })

    await this.flushPromise
  }

  async run(): Promise<void> {
    this.stopped = false

    while (!this.stopped) {
      try {
        await this.pollOnce()
      } catch (error) {
        const rateLimit = asRateLimitError(error)
        if (rateLimit) {
          const retryAfterMs = rateLimit.retryAfterMs ?? this.reconnectDelayMs
          const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
          this.log('warn', `${rateLimit.message} Retrying in ${String(retryAfterSeconds)}s.`)
          if (this.stopped) break
          await wait(retryAfterMs)
          continue
        }

        const message = error instanceof Error ? error.message : 'Unknown connector error'
        this.log('error', `Connector loop failed: ${message}`)
        this.sessionId = ''
        if (this.stopped) break
        await wait(this.reconnectDelayMs)
      }
    }
  }

  dispose(): void {
    this.stopped = true
    this.sessionId = ''
    if (this.notificationFlushTimer) {
      clearTimeout(this.notificationFlushTimer)
      this.notificationFlushTimer = null
    }
    this.unsubscribeNotificationListener()
    this.appServer.dispose?.()
  }

  async processRequestEnvelope(message: RelayRequestEnvelope): Promise<void> {
    this.activeRoute = message.route

    try {
      if (message.method === RELAY_E2EE_RPC_METHOD) {
        await this.processEncryptedRequest(message)
      } else {
        const result = await this.appServer.rpc(message.method, message.params ?? null)
        this.pendingMessages.push(this.buildResponse(message, { result }))
      }
    } catch (error) {
      this.pendingMessages.push(this.buildResponse(message, {
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Relay connector request failed',
        },
      }))
    }
  }

  private async processEncryptedRequest(message: RelayRequestEnvelope): Promise<void> {
    if (!this.relayE2ee) {
      throw new Error('Relay E2EE request received without local E2EE configuration')
    }

    const encryptedEnvelope = normalizeRelayE2eeEnvelope(asRecord(message.params)?.e2ee)
    if (!encryptedEnvelope) {
      throw new Error('Malformed relay E2EE request envelope')
    }

    const decrypted = await decryptRelayE2eePayload(encryptedEnvelope, this.relayE2ee)
    const decryptedRecord = asRecord(decrypted)
    const method = typeof decryptedRecord?.method === 'string' ? decryptedRecord.method.trim() : ''
    if (!method) {
      throw new Error('Encrypted relay payload did not include a method')
    }

    const result = await this.appServer.rpc(method, decryptedRecord?.params ?? null)
    const encryptedResult = await encryptRelayE2eePayload({ result }, this.relayE2ee)
    this.pendingMessages.push(this.buildResponse(message, {
      result: {
        e2ee: encryptedResult,
      },
    }))
  }

  private async handleLocalNotification(notification: RelayConnectorNotification): Promise<void> {
    if (!this.activeRoute) {
      return
    }

    if (this.relayE2ee) {
      const encryptedEvent = await encryptRelayE2eePayload(
        {
          method: notification.method,
          params: notification.params ?? null,
        },
        this.relayE2ee,
      )
      this.pendingMessages.push(this.buildEvent(RELAY_E2EE_RPC_METHOD, { e2ee: encryptedEvent }))
    } else {
      this.pendingMessages.push(this.buildEvent(notification.method, notification.params ?? null))
    }

    this.scheduleNotificationFlush()
  }

  private scheduleNotificationFlush(): void {
    if (this.stopped || this.notificationFlushTimer || this.flushPromise) {
      return
    }

    this.notificationFlushTimer = setTimeout(() => {
      this.notificationFlushTimer = null
      void this.flushPendingMessages().catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to push local notification'
        this.log('warn', message)
        if (!this.stopped && this.pendingMessages.length > 0) {
          this.scheduleNotificationFlush()
        }
      })
    }, this.notificationFlushDelayMs)
  }

  private buildResponse(
    request: RelayRequestEnvelope,
    payload: { result?: unknown; error?: { code: number; message: string } },
  ): RelayResponseEnvelope {
    return {
      protocol: RELAY_PROTOCOL,
      version: RELAY_PROTOCOL_VERSION,
      kind: 'response',
      relayId: request.relayId,
      route: request.route,
      ...(payload.error ? { error: payload.error } : { result: payload.result ?? null }),
      sentAtIso: new Date().toISOString(),
    }
  }

  private buildEvent(event: string, params: unknown): RelayEventEnvelope {
    if (!this.activeRoute) {
      throw new Error('Cannot emit relay event without an active route')
    }

    return {
      protocol: RELAY_PROTOCOL,
      version: RELAY_PROTOCOL_VERSION,
      kind: 'event',
      event,
      route: this.activeRoute,
      params,
      sentAtIso: new Date().toISOString(),
    }
  }

  private log(level: RelayConnectorLogLevel, message: string): void {
    this.onLog?.(level, message)
  }
}
