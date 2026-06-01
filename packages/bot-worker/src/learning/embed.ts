const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const FINDING_EMBEDDING_DIMENSIONS = 768;

type FetchLike = typeof fetch;

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: unknown;
  }>;
}

export interface OpenAIFindingEmbedderOptions {
  apiKey: string;
  fetch?: FetchLike;
  model?: string;
  dimensions?: number;
}

export class OpenAIFindingEmbedder {
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #model: string;
  readonly #dimensions: number;

  constructor(options: OpenAIFindingEmbedderOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#model = options.model ?? OPENAI_EMBEDDING_MODEL;
    this.#dimensions = options.dimensions ?? FINDING_EMBEDDING_DIMENSIONS;
  }

  async embedFindingSummary(summary: string): Promise<number[]> {
    const response = await this.#fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.#model,
        input: summary,
        dimensions: this.#dimensions,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI embedding request failed with ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as OpenAIEmbeddingResponse;
    const embedding = body.data?.[0]?.embedding;
    if (!isNumberArray(embedding)) {
      throw new Error('OpenAI embedding response did not include a numeric embedding');
    }
    if (embedding.length !== this.#dimensions) {
      throw new Error(
        `OpenAI embedding response had ${embedding.length} dimensions; expected ${this.#dimensions}`,
      );
    }

    return embedding;
  }
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}
