/**
 * Dependency injection container and service registry.
 *
 * Provides:
 *  - BaseService interface with initialize/shutdown lifecycle
 *  - ServiceRegistry for registering and resolving services
 *
 * Design constraints (Architecture Section 19):
 *  - No direct module-to-module imports; all wiring happens here.
 *  - Modules communicate only via the Event Bus or injected interface dependencies.
 *  - Services must support initialize() and shutdown() lifecycle methods.
 */

// ---------------------------------------------------------------------------
// BaseService interface
// ---------------------------------------------------------------------------

/**
 * Lifecycle interface for all orchestrator services/modules.
 * Every module must implement this to participate in graceful startup/shutdown.
 */
export interface BaseService {
  /**
   * Initialize the service — set up connections, subscribe to events, etc.
   * Called after all services are constructed but before the orchestrator
   * emits orchestrator:ready.
   */
  initialize(): Promise<void>

  /**
   * Tear down the service gracefully.
   * Called during orchestrator shutdown in reverse dependency order.
   */
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

/** Map of service name to registered service instance */
type ServiceMap = Map<string, BaseService>

/**
 * Simple service registry — stores named service instances for DI resolution.
 *
 * Services are registered by name and can be retrieved by name or iterated
 * in registration order for lifecycle management.
 *
 * @example
 * const registry = new ServiceRegistry()
 * registry.register('taskGraph', taskGraphEngine)
 * registry.register('workerManager', workerManager)
 *
 * // Initialize all services
 * await registry.initializeAll()
 *
 * // Shutdown all services in reverse order
 * await registry.shutdownAll()
 */
export class ServiceRegistry {
  private readonly _services: ServiceMap = new Map()
  private readonly _order: string[] = []

  /**
   * Register a named service. Registration order is preserved for lifecycle calls.
   * @throws {Error} if a service with the same name is already registered.
   */
  register(name: string, service: BaseService): void {
    if (this._services.has(name)) {
      throw new Error(`Service "${name}" is already registered`)
    }
    this._services.set(name, service)
    this._order.push(name)
  }

  /**
   * Retrieve a registered service by name.
   * @throws {Error} if no service with the given name is registered.
   */
  get(name: string): BaseService {
    const service = this._services.get(name)
    if (service === undefined) {
      throw new Error(`Service "${name}" is not registered`)
    }
    return service
  }

  /**
   * Returns true if a service with the given name is registered.
   */
  has(name: string): boolean {
    return this._services.has(name)
  }

  /**
   * Initialize all registered services in registration order.
   * Fails fast on the first error — later services may depend on
   * already-initialized ones, so continuing after a failure is unsafe.
   * @throws the first initialization error encountered.
   */
  async initializeAll(): Promise<void> {
    for (const name of this._order) {
      const service = this._services.get(name)
      if (service !== undefined) {
        await service.initialize()
      }
    }
  }

  /**
   * Shut down all registered services in reverse registration order.
   * Errors are collected and re-thrown as an AggregateError after all services
   * have had a chance to shut down.
   */
  async shutdownAll(): Promise<void> {
    const errors: Error[] = []
    const reversed = [...this._order].reverse()

    for (const name of reversed) {
      const service = this._services.get(name)
      if (service !== undefined) {
        try {
          await service.shutdown()
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Shutdown errors in ${errors.length} service(s)`)
    }
  }

  /** Return names of all registered services in registration order */
  get serviceNames(): string[] {
    return [...this._order]
  }
}
