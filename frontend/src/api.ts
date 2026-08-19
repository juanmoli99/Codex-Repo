import type { OperationsSnapshot } from './types.js';

export class ApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly correlationId?: string,
  ) {
    super(message);
  }
}

interface ApiErrorResponse {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly correlationId?: string;
  };
}

export class ApiClient {
  private csrfToken: string | undefined = window.sessionStorage.getItem('aegis.csrf') ?? undefined;

  public async session(): Promise<boolean> {
    try {
      await this.request('/api/auth/session');
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return false;
      throw error;
    }
  }

  public async login(username: string, password: string): Promise<void> {
    const response = await this.request<{ csrfToken: string }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      authenticatedMutation: false,
    });
    this.csrfToken = response.csrfToken;
    window.sessionStorage.setItem('aegis.csrf', response.csrfToken);
  }

  public async logout(): Promise<void> {
    await this.request('/api/auth/logout', { method: 'POST', body: {} });
    this.csrfToken = undefined;
    window.sessionStorage.removeItem('aegis.csrf');
  }

  public snapshot(signal?: AbortSignal): Promise<OperationsSnapshot> {
    return this.request('/api/operations/snapshot', signal === undefined ? {} : { signal });
  }

  public action<T = unknown>(
    action: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    return this.request(`/api/operations/actions/${encodeURIComponent(action)}`, {
      method: 'POST',
      body: payload,
    });
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
      authenticatedMutation?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const method = options.method ?? 'GET';
      const response = await fetch(path, {
        method,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method === 'GET' ||
          options.authenticatedMutation === false ||
          this.csrfToken === undefined
            ? {}
            : { 'x-csrf-token': this.csrfToken }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      const data = raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
      if (!response.ok) {
        const body = data as ApiErrorResponse | undefined;
        throw new ApiError(
          body?.error?.code ?? 'HTTP_ERROR',
          body?.error?.message ?? `Request failed with HTTP ${response.status}`,
          response.status,
          body?.error?.correlationId,
        );
      }
      return data as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError')
        throw new ApiError('REQUEST_TIMEOUT', 'El backend no respondió a tiempo', 0);
      throw new ApiError('NETWORK_ERROR', 'No se pudo conectar con el backend', 0);
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

export const api = new ApiClient();
