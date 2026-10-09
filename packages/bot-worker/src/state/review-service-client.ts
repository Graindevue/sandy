import { ConvexHttpClient } from 'convex/browser';

const AUDIENCE = 'sandy-review';
const REFRESH_MARGIN_MS = 60_000;

/** A service token is kept in memory and refreshed before every backend call. */
export class ReviewServiceClient {
  readonly #client: ConvexHttpClient;
  readonly #requestUrl: URL;
  readonly #requestToken: string;
  #token: { value: string; expiresAt: number } | undefined;
  #refresh: Promise<void> | undefined;

  constructor(url: string, env: NodeJS.ProcessEnv) {
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrl || !requestToken) {
      throw new Error('Convex service authentication requires GitHub Actions id-token: write');
    }
    this.#requestUrl = new URL(requestUrl);
    if (
      this.#requestUrl.protocol !== 'https:' ||
      !this.#requestUrl.hostname.endsWith('.actions.githubusercontent.com') ||
      this.#requestUrl.username ||
      this.#requestUrl.password
    ) {
      throw new Error('Invalid GitHub Actions OIDC endpoint');
    }
    this.#requestUrl.searchParams.set('audience', AUDIENCE);
    this.#requestToken = requestToken;
    this.#client = new ConvexHttpClient(url, { logger: false });
  }

  readonly query: ConvexHttpClient['query'] = async (query, ...args) => {
    return await this.#request(() => this.#client.query(query, ...args));
  };

  readonly mutation: ConvexHttpClient['mutation'] = async (mutation, ...args) => {
    return await this.#request(() => this.#client.mutation(mutation, ...args));
  };

  readonly action: ConvexHttpClient['action'] = async (action, ...args) => {
    return await this.#request(() => this.#client.action(action, ...args));
  };

  async #request<T>(request: () => Promise<T>): Promise<T> {
    await this.#authenticate();
    const token = this.#token?.value;
    try {
      return await request();
    } catch (error) {
      // Defense against a gateway reflecting an Authorization value in its
      // diagnostic. Ordinary Convex errors retain their useful state context.
      if (
        error instanceof Error &&
        (error.message.includes(this.#requestToken) || (token && error.message.includes(token)))
      ) {
        throw new Error('Convex service request failed');
      }
      throw error;
    }
  }

  async #authenticate(): Promise<void> {
    if (this.#token !== undefined && this.#token.expiresAt > Date.now() + REFRESH_MARGIN_MS) return;
    this.#refresh ??= this.#fetchToken().finally(() => {
      this.#refresh = undefined;
    });
    await this.#refresh;
  }

  async #fetchToken(): Promise<void> {
    // Never log the response, headers, raw JWT, or provider error. These tokens
    // are not function arguments, on-disk credentials, or child-process env.
    try {
      const response = await fetch(this.#requestUrl, {
        headers: { Authorization: `Bearer ${this.#requestToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('OIDC request failed');
      const result: unknown = await response.json();
      const token = (result as { value?: unknown } | null)?.value;
      if (typeof token !== 'string' || token.length > 16_384) throw new Error('Invalid token');
      const parts = token.split('.');
      if (parts.length !== 3 || !parts[1]) throw new Error('Invalid JWT');
      const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      const expiresAt = (claims as { exp?: unknown } | null)?.exp;
      if (
        typeof expiresAt !== 'number' ||
        !Number.isFinite(expiresAt) ||
        expiresAt * 1000 <= Date.now() + REFRESH_MARGIN_MS
      )
        throw new Error('Expired token');
      // Convex checks the signature, issuer, audience, and expiry. Decoding here
      // only schedules refresh, and never makes an authorization decision.
      this.#token = { value: token, expiresAt: expiresAt * 1000 };
      this.#client.setAuth(token);
    } catch {
      this.#token = undefined;
      this.#client.clearAuth();
      throw new Error('Unable to authenticate the Sandy service with GitHub Actions OIDC');
    }
  }
}
