import type { RelayConnectorAppServer, RelayConnectorNotification } from './core.js'
import { executeServerFsBridgeMethod, isServerFsBridgeMethod } from '../shared/serverFsBridge.js'

export class CodexUiConnectorAppServer implements RelayConnectorAppServer {
  private readonly delegate: RelayConnectorAppServer

  constructor(delegate: RelayConnectorAppServer) {
    this.delegate = delegate
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (isServerFsBridgeMethod(method)) {
      return await executeServerFsBridgeMethod(method, params)
    }
    return await this.delegate.rpc(method, params)
  }

  onNotification(listener: (notification: RelayConnectorNotification) => void): () => void {
    return this.delegate.onNotification(listener)
  }

  dispose(): void {
    this.delegate.dispose?.()
  }
}
