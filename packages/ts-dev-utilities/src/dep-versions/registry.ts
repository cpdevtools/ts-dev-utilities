import type { DepVersionHandler } from './types.js';
import { npmHandler } from './handlers/npm.js';
import { dotnetHandler } from './handlers/dotnet.js';
import { dockerHandler } from './handlers/docker.js';
import { githubActionsHandler } from './handlers/github-actions.js';

export class HandlerRegistry {
  private readonly _handlers = new Map<string, DepVersionHandler>();

  register(handler: DepVersionHandler): this {
    this._handlers.set(handler.name, handler);
    return this;
  }

  get(name: string): DepVersionHandler | undefined {
    return this._handlers.get(name);
  }

  getAll(): DepVersionHandler[] {
    return [...this._handlers.values()];
  }
}

/** Pre-built registry with all built-in handlers. */
export const defaultRegistry = new HandlerRegistry()
  .register(npmHandler)
  .register(dotnetHandler)
  .register(dockerHandler)
  .register(githubActionsHandler);

/** Register a custom handler on the default registry. */
export function registerHandler(handler: DepVersionHandler): void {
  defaultRegistry.register(handler);
}
