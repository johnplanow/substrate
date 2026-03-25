// packages/factory/src/llm/client.ts
import type { ProviderAdapter, LLMRequest, LLMResponse, StreamEvent } from './types.js'
import { ModelRegistry } from './model-registry.js'
import type { MiddlewareFn, MiddlewareNext } from './middleware/types.js'
import { buildMiddlewareChain } from './middleware/types.js'

export class LLMClient {
  private adapters = new Map<string, ProviderAdapter>()
  private modelRegistry = new ModelRegistry()
  private _middleware: MiddlewareFn[] = []

  constructor(adapters?: Record<string, ProviderAdapter>) {
    if (adapters) {
      for (const [name, adapter] of Object.entries(adapters)) {
        this.registerProvider(name, adapter)
      }
    }
  }

  registerProvider(name: string, adapter: ProviderAdapter): void {
    this.adapters.set(name, adapter)
  }

  registerModelPattern(pattern: string, providerName: string): void {
    this.modelRegistry.register(pattern, providerName)
  }

  /**
   * Register a middleware function that wraps every `complete()` call.
   * Returns `this` for chaining.
   */
  use(mw: MiddlewareFn): this {
    this._middleware.push(mw)
    return this
  }

  private resolveAdapter(model: string): ProviderAdapter {
    const providerName = this.modelRegistry.resolve(model)
    const registered = [...this.adapters.keys()]
    if (!providerName) {
      throw new Error(
        `No provider matched model "${model}". Registered providers: ${registered.join(', ') || '(none)'}`,
      )
    }
    const adapter = this.adapters.get(providerName)
    if (!adapter) {
      throw new Error(
        `Provider "${providerName}" matched model "${model}" but is not registered. Registered providers: ${registered.join(', ') || '(none)'}`,
      )
    }
    return adapter
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const baseNext: MiddlewareNext = (req) => this.resolveAdapter(req.model).complete(req)
    const chain = buildMiddlewareChain(this._middleware, baseNext)
    return chain(request)
  }

  // stream() is NOT wrapped by middleware — it delegates directly to the adapter
  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    yield* this.resolveAdapter(request.model).stream(request)
  }
}
