export interface ControlApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const TRAILING_SLASH_PATTERN = /\/+$/u;

export class ControlApiClient {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: ControlApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(TRAILING_SLASH_PATTERN, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Control API GET ${path} failed (${res.status}): ${err}`);
    }
    return (await res.json()) as T;
  }

  getAgents<T = unknown>(): Promise<T> {
    return this.get<T>("/control/agents");
  }

  getProviders<T = unknown>(): Promise<T> {
    return this.get<T>("/control/providers");
  }

  getModels<T = unknown>(): Promise<T> {
    return this.get<T>("/control/models");
  }

  getMcps<T = unknown>(): Promise<T> {
    return this.get<T>("/control/mcps");
  }

  getSkills<T = unknown>(): Promise<T> {
    return this.get<T>("/control/skills");
  }

  getHooks<T = unknown>(): Promise<T> {
    return this.get<T>("/control/hooks");
  }

  getPermissions<T = unknown>(): Promise<T> {
    return this.get<T>("/control/permissions");
  }

  getPrompts<T = unknown>(): Promise<T> {
    return this.get<T>("/control/prompts");
  }

  getWorkspaces<T = unknown>(): Promise<T> {
    return this.get<T>("/control/workspaces");
  }

  getRouting<T = unknown>(): Promise<T> {
    return this.get<T>("/control/routing");
  }

  getRuntime<T = unknown>(): Promise<T> {
    return this.get<T>("/control/runtime");
  }

  async patchProviderRole<T = unknown>(
    provider: string,
    role: "orchestrator" | "subagent",
    enabled: boolean
  ): Promise<T> {
    const path = `/control/providers/${encodeURIComponent(provider)}/roles/${role}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Control API PATCH ${path} failed (${res.status}): ${err}`);
    }
    return (await res.json()) as T;
  }
}
