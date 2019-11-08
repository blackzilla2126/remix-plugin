import { PluginManager, IPluginManager } from "../plugin/manager"
import { Plugin } from '../plugin/abstract'
import { listenEvent } from "../../../utils"

export class Engine {
  private manager: IPluginManager
  private plugins: Record<string, Plugin>
  private events: Record<string, any>
  private listeners: Record<string, any>

  onRegistration?(plugin: Plugin): void
  onActivated?(plugin: Plugin): void
  onDeactivated?(plugin: Plugin): void

  constructor(managerProfile) {
    this.manager = new PluginManager(managerProfile)
    this.register(this.manager)
    this.activateManager()
  }

  /** Activate the Engine & start listening on activation and deactivation */
  private async activateManager() {
    await this.activatePlugin('manager')
    this.addListener('__root__', 'manager', 'activated', ({name}) => this.activatePlugin(name))
    this.addListener('__root__', 'manager', 'deactivated', ({name}) => this.deactivatePlugin(name))
  }

  /**
   * Broadcast an event to the plugin listening
   * @param emitter Plugin name that emit the event
   * @param event The name of the event
   * @param payload The content of the event
   */
  private broadcast(emitter: string, event: string, ...payload: any[]) {
    const eventName = listenEvent(emitter, event)
    if (!this.listeners[eventName]) return // Nobody is listening
    const listeners = this.listeners[eventName] || []
    listeners.forEach(listener => {
      if (!this.events[listener][eventName]) {
        throw new Error(`Plugin ${listener} should be listening on event ${event} from ${emitter}. But no callback have been found`)
      }
      this.events[listener][eventName](...payload)
    })
  }

  /**
   * Start listening on an event from another plugin
   * @param listener The name of the plugin that listen on the event
   * @param emitter The name of the plugin that emit the event
   * @param event The name of the event
   * @param cb Callback function to trigger when event is trigger
   */
  private addListener(listener: string, emitter: string, event: string, cb: Function) {
    const eventName = listenEvent(emitter, event)
    // If not already listening
    if (!this.events[listener][eventName]) {
      this.events[listener][eventName] = cb
    }
    // Record that "listener" is listening on "emitter"
    if (!this.listeners[eventName]) this.listeners[eventName] = []
    // If not already recorded
    if (!this.listeners[eventName].includes(name)) {
      this.listeners[eventName].push(name)
    }
  }

  /**
   * Remove an event from the list of events of a listener
   * @param listener The name of the plugin that was listening on the event
   * @param emitter The name of the plugin that emit the event
   * @param event The name of the event
   */
  private removeListener(listener: string, emitter: string, event: string) {
    const eventName = listenEvent(emitter, event)
    // Remove listener
    this.listeners[eventName] = this.listeners[eventName].filter(name => name !== listener)
    // Remove callback
    delete this.events[listener][eventName]
  }

  /**
   * Create a listener that listen only once on an event
   * @param listener The name of the plugin that listen on the event
   * @param emitter The name of the plugin that emit the event
   * @param event The name of the event
   * @param cb Callback function to trigger when event is trigger
   */
  private listenOnce(listener: string, emitter: string, event: string, cb: Function) {
    this.addListener(listener, emitter, event, (...args: any[]) => {
      cb(...args)
      this.removeListener(listener, emitter, event)
    })
  }


  /**
   * Call a method of a plugin from another
   * @param caller The name of the plugin that call the method
   * @param target The name of the plugin that manage the method
   * @param method The name of the method
   * @param payload The argument to pass to the method
   */
  private async callMethod(caller: string, target: string, method: string, ...payload: any[]) {
    if (!this.plugins[target]) {
      throw new Error(`Cannot call ${target} from ${caller}, because ${target} is not registered`)
    }

    // Get latest version of the profiles
    const [ to, from ] = await Promise.all([
      this.manager.getProfile(caller),
      this.manager.getProfile(target)
    ])

    // Check if plugin FROM can call METHOD of plugin TO
    const canCall = await this.manager.canCall(from, to, method)
    if (!canCall) {
      throw new Error(`Plugin "${caller}" don't have permission to call method "${method}" of plugin "${target}"`)
    }

    // Check if plugin FROM can activate plugin TO
    const isActive = await this.manager.isActive(target)
    if (!isActive) {
      const canActivate = await this.manager.canActivate(from, to)
      if (canActivate) {
        await this.manager.toggleActive(target)
      } else {
        throw new Error(`Cannot call ${method} from ${target}, because ${target} is not activated yet`)
      }
    }

    // Check if method is exposed
    if (!to.methods.includes(method)) {
      const notExposedMsg = `Cannot call method "${method}" of "${target}" from "${caller}", because "${method}" is not exposed.`
      const exposedMethodsMsg = `Here is the list of exposed methods: ${to.methods.map(m => `"${m}"`).join(',')}`
      throw new Error(`${notExposedMsg} ${exposedMethodsMsg}`)
    }

    const request = { from: caller }
    return this.plugins[target]['addRequest'](request, method, payload)
  }

  /**
   * Create an object to access easily any plugin registered
   * @param name Name of the caller plugin
   * @note This method creates a snapshot at the time of the time of activation
   */
  private async createApp(name: string) {
    const getProfiles = Object.keys(this.plugins).map(key => this.manager.getProfile(key))
    const profiles = await Promise.all(getProfiles)
    return profiles.reduce((app, target) => {
      app[target.name] = target.methods.reduce((methods, method) => {
        methods[method] = (...payload: any[]) => this.callMethod(name, target.name, method, ...payload)
        return methods
      }, {
        on: (event: string, cb: (...payload: any[]) => void) => this.addListener(name, target.name, event, cb),
        once: (event: string, cb: (...payload: any[]) => void) => this.listenOnce(name, target.name, event, cb),
        off: (event: string) => this.removeListener(name, target.name, event),
        profile: target
      })
      return app
    }, {})
  }

  /**
   * Activate a plugin by making its method and event available
   * @param name The name of the plugin
   * @note This method is trigger by the plugin manager when a plugin has been activated
   */
  private async activatePlugin(name: string) {
    if (!this.plugins[name]) {
      throw new Error(`Cannot active plugin ${name} because it's not registered yet`)
    }
    const isActive = await this.manager.isActive(name)
    if (isActive) return

    const plugin = this.plugins[name]
    this.events[name] = {}
    plugin['on'] = (emitter: string, event: string, cb: (...payload: any[]) => void) => {
      this.addListener(name, emitter, event, cb)
    }
    plugin['once'] = (emitter: string, event: string, cb: (...payload: any[]) => void) => {
      this.listenOnce(name, emitter, event, cb)
    }
    plugin['off'] = (emitter: string, event: string) => {
      this.removeListener(name, emitter, event)
    }
    plugin['emit'] = (event: string, ...payload: any[]) => {
      this.broadcast(name, event, ...payload)
    }
    plugin['call'] = (target: string, method: string, ...payload: any[]) => {
      return this.callMethod(name, target, method, ...payload)
    }

    // GIVE ACCESS TO APP
    plugin['app'] = await this.createApp(name)
    plugin['createApp'] = () => this.createApp(name)

    // Call hooks
    await plugin.activate()
    if (this.onActivated) this.onActivated(plugin)
  }

  /**
   * Deactivate a plugin by removing all event listeners and making it inaccessible
   * @param name The name of the plugin
   * @note This method is trigger by the plugin manager when a plugin has been deactivated
   */
  private async deactivatePlugin(name: string) {
    if (!this.plugins[name]) {
      throw new Error(`Cannot deactive plugin ${name} because it's not registered yet`)
    }
    const isActive = await this.manager.isActive(name)
    if (!isActive) return

    const plugin = this.plugins[name]
    // Call hooks
    await plugin.deactivate()

    // REMOVE CALL / LISTEN / EMIT
    const deactivatedWarning = (message: string) => {
      return `Plugin ${name} is currently deactivated. ${message}. Activate ${name} first`
    }
    plugin['call'] = (target: string, key: string, ...payload: any[]) => {
      throw new Error(deactivatedWarning(`It cannot call method ${key} of plugin ${target}.`))
    }
    plugin['on'] = (target: string, event: string) => {
      throw new Error(deactivatedWarning(`It cannot listen on event ${event} of plugin ${target}.`))
    }
    plugin['once'] = (target: string, event: string) => {
      throw new Error(deactivatedWarning(`It cannot listen on event ${event} of plugin ${target}.`))
    }
    plugin['off'] = (target: string, event: string) => {
      throw new Error(deactivatedWarning('All event listeners are already removed.'))
    }
    plugin['emit'] = (event: string, ...payload: any[]) => {
      throw new Error(deactivatedWarning(`It cannot emit the event ${event}`))
    }

    // REMOVE PLUGIN APP
    delete plugin['app']
    delete plugin['createApp']

    // REMOVE LISTENER
    // Note : We don't remove the listeners of this plugin.
    // Because we would keep track of them to reactivate them on reactivation. Which doesn't make sense
    delete this.events[name]

    // REMOVE EVENT RECORD
    Object.keys(this.listeners).forEach(eventName => {
      this.listeners[eventName].forEach((listener, i) => {
        if (listener === name) this.listeners[eventName].splice(i, 1)
      })
    })

    // Once everything is deactivated
    if (this.onDeactivated) this.onDeactivated(plugin)
  }

  /**
   * Register a plugin to the engine and update the manager
   * @param plugin The plugin
   */
  register(plugin: Plugin) {
    if (this.plugins[plugin.name]) {
      throw new Error(`Plugin ${plugin.name} is already register.`)
    }
    this.plugins[plugin.name] = plugin
    this.manager.addProfile(plugin.profile)
    if (this.onRegistration) this.onRegistration(plugin)
  }
}