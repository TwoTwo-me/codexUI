import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(__dirname, '../..')

async function loadConnectorModule() {
  const moduleUrl = pathToFileURL(resolve(repoDir, 'dist-cli/connector.js')).href
  return await import(`${moduleUrl}?t=${Date.now()}`)
}

test('connector package processes relay RPC requests and forwards notifications', async () => {
  const module = await loadConnectorModule()
  assert.equal(typeof module.CodexRelayConnector, 'function')

  const pushedBatches = []
  let notificationListener = null
  let pullCount = 0

  const requestEnvelope = {
    protocol: 'codexui.relay.v1',
    version: 1,
    kind: 'request',
    relayId: 'relay-1',
    route: {
      scopeKey: 'user:user-1',
      serverId: 'alpha-edge',
      channelId: 'agent:agent-1',
    },
    method: 'thread/list',
    params: { archived: false },
    sentAtIso: '2026-03-06T09:00:00.000Z',
  }

  const connector = new module.CodexRelayConnector({
    token: 'connector-token',
    transport: {
      async connect(token) {
        assert.equal(token, 'connector-token')
        return {
          sessionId: 'session-1',
          pollTimeoutMs: 0,
        }
      },
      async pull(_token, _sessionId) {
        pullCount += 1
        return pullCount === 1 ? [requestEnvelope] : []
      },
      async push(_token, _sessionId, messages) {
        pushedBatches.push(structuredClone(messages))
      },
    },
    appServer: {
      async rpc(method, params) {
        return {
          handledMethod: method,
          handledParams: params,
        }
      },
      onNotification(listener) {
        notificationListener = listener
        return () => {
          notificationListener = null
        }
      },
    },
  })

  await connector.connect()
  await connector.pollOnce()

  assert.equal(pushedBatches.length, 1)
  assert.equal(pushedBatches[0].length, 1)
  assert.equal(pushedBatches[0][0].kind, 'response')
  assert.equal(pushedBatches[0][0].relayId, 'relay-1')
  assert.deepEqual(pushedBatches[0][0].result, {
    handledMethod: 'thread/list',
    handledParams: { archived: false },
  })

  assert.equal(typeof notificationListener, 'function')
  notificationListener({ method: 'thread/updated', params: { threadId: 'thr-1' } })
  await connector.flushPendingMessages()

  assert.equal(pushedBatches.length, 2)
  assert.equal(pushedBatches[1].length, 1)
  assert.equal(pushedBatches[1][0].kind, 'event')
  assert.equal(pushedBatches[1][0].event, 'thread/updated')
  assert.deepEqual(pushedBatches[1][0].params, { threadId: 'thr-1' })
})

test('connector batches burst notifications into fewer push requests', async () => {
  const module = await loadConnectorModule()
  const pushedBatches = []
  let notificationListener = null

  const connector = new module.CodexRelayConnector({
    token: 'connector-token',
    notificationFlushDelayMs: 100,
    transport: {
      async connect() {
        return {
          sessionId: 'session-1',
          pollTimeoutMs: 0,
        }
      },
      async pull() {
        return []
      },
      async push(_token, _sessionId, messages) {
        pushedBatches.push(structuredClone(messages))
      },
    },
    appServer: {
      async rpc() {
        return null
      },
      onNotification(listener) {
        notificationListener = listener
        return () => {
          notificationListener = null
        }
      },
    },
  })

  await connector.connect()
  connector['activeRoute'] = {
    scopeKey: 'user:user-1',
    serverId: 'alpha-edge',
    channelId: 'agent:agent-1',
  }

  assert.equal(typeof notificationListener, 'function')
  notificationListener({ method: 'thread/updated', params: { seq: 1 } })
  notificationListener({ method: 'thread/updated', params: { seq: 2 } })
  notificationListener({ method: 'thread/updated', params: { seq: 3 } })

  await new Promise((resolve) => setTimeout(resolve, 160))

  assert.equal(pushedBatches.length, 1)
  assert.equal(pushedBatches[0].length, 3)
  assert.deepEqual(pushedBatches[0].map((entry) => entry.params.seq), [1, 2, 3])
})

test('connector run waits for relay rate limits without reconnecting the session', async () => {
  const module = await loadConnectorModule()
  const logs = []
  let connectCount = 0
  let pullCount = 0
  let connector

  connector = new module.CodexRelayConnector({
    token: 'connector-token',
    reconnectDelayMs: 5,
    transport: {
      async connect() {
        connectCount += 1
        return {
          sessionId: 'session-1',
          pollTimeoutMs: 0,
        }
      },
      async pull() {
        pullCount += 1
        if (pullCount === 1) {
          const error = new Error('Too many relay agent requests. Try again later.')
          error.statusCode = 429
          error.retryAfterMs = 10
          throw error
        }
        connector.dispose()
        return []
      },
      async push() {
        return undefined
      },
    },
    appServer: {
      async rpc() {
        return null
      },
      onNotification() {
        return () => undefined
      },
    },
    onLog(level, message) {
      logs.push({ level, message })
    },
  })

  await connector.run()

  assert.equal(connectCount, 1)
  assert.equal(pullCount, 2)
  assert.ok(logs.some((entry) => entry.level === 'warn' && /Retrying in 1s/i.test(entry.message)))
  assert.ok(!logs.some((entry) => entry.level === 'error' && /Too many relay agent requests/i.test(entry.message)))
})
