import type { Message, Api, ApiMap } from '@remixproject/plugin-utils'
import {
  ClientConnector,
  connectClient,
  applyApi,
  Client,
  PluginClient,
  isHandshake,
  PluginOptions,
  checkOrigin
} from '@remixproject/plugin'

declare const acquireVsCodeApi: any
/**
 * This Webview connector
 */
export class WebviewConnector implements ClientConnector {
  source: { postMessage: (message: any, origin?: string) => void }
  origin: string
  isVscode: boolean

  constructor(private options: PluginOptions<any>) {
    this.isVscode = !!acquireVsCodeApi
    this.source = this.isVscode ? acquireVsCodeApi() : window.parent
  }


  /** Send a message to the engine */
  send(message: Partial<Message>) {
    if (this.isVscode) {
      this.source.postMessage(message)
    } else if (this.origin || isHandshake(message)) {
      const origin = this.origin || '*'
      this.source.postMessage(message, origin)
    }
  }

  /** Get messae from the engine */
  on(cb: (message: Partial<Message>) => void) {
    window.addEventListener('message', async (event: MessageEvent) => {
      if (!event.source) throw new Error('No source')
      if (!event.data) throw new Error('No data')
      // Support for iframe
      if (!this.isVscode) {
        // Check that the origin is the right one
        const devMode = this.options.devMode
        const isGoodOrigin = await checkOrigin(event.origin, devMode)
        if (!isGoodOrigin) return
        if (isHandshake(event.data)) {
          this.origin = event.origin
          this.source = event.source as Window
        }
      }
      cb(event.data)

    }, false)
  }
}

/**
 * Connect a Webview plugin client to a web engine
 * @param client An optional websocket plugin client to connect to the engine.
 */
export const createClient = <
  P extends Api,
  App extends ApiMap
>(client: PluginClient<P, App> = new PluginClient()): Client<P, App> => {
  const c = client as any
  const options = client.options
  const connector = new WebviewConnector(options)
  connectClient(connector, c)
  applyApi(c)
  return client as any
}