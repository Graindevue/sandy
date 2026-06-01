export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
export const FINDING_EMBEDDING_DIMENSIONS = 768;

type FetchLike = typeof fetch;

interface OllamaEmbeddingResponse {
  embedding?: unknown;
}

export interface OllamaFindingEmbedderOptions {
  host?: string;
  fetch?: FetchLike;
  model?: string;
  dimensions?: number;
}

export class OllamaFindingEmbedder {
  readonly #endpoint: string;
  readonly #fetch: FetchLike;
  readonly #model: string;
  readonly #dimensions: number;

  constructor(options: OllamaFindingEmbedderOptions = {}) {
    this.#endpoint = `${normalizeOllamaHost(options.host)}/api/embeddings`;
    this.#fetch = options.fetch ?? fetch;
    this.#model = options.model ?? OLLAMA_EMBEDDING_MODEL;
    this.#dimensions = options.dimensions ?? FINDING_EMBEDDING_DIMENSIONS;
  }

  async embedFindingSummary(summary: string): Promise<number[]> {
    const response = await this.#requestEmbedding(summary);

    if (!response.ok) {
      throw new Error(
        `Ollama embedding request failed with ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as OllamaEmbeddingResponse;
    const embedding = body.embedding;
    if (!isNumberArray(embedding)) {
      throw new Error('Ollama embedding response did not include a numeric embedding');
    }
    if (embedding.length !== this.#dimensions) {
      throw new Error(
        `Ollama embedding response had ${embedding.length} dimensions; expected ${this.#dimensions}`,
      );
    }

    return embedding;
  }

  async #requestEmbedding(summary: string): Promise<Response> {
    try {
      return await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.#model,
          prompt: summary,
        }),
      });
    } catch (error) {
      throw new Error(`Ollama embedding request failed: ${errorMessage(error)}`, { cause: error });
    }
  }
}

function normalizeOllamaHost(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return DEFAULT_OLLAMA_HOST;
  }
  return trimmed.replace(/\/+$/, '');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
