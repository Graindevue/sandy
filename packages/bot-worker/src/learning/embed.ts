const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const TEXT_EMBEDDING_3_SMALL_DIMENSIONS = 1536;

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
  expectedDimensions?: number;
}

export class OpenAIFindingEmbedder {
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #model: string;
  readonly #expectedDimensions: number;

  constructor(options: OpenAIFindingEmbedderOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#model = options.model ?? OPENAI_EMBEDDING_MODEL;
    this.#expectedDimensions = options.expectedDimensions ?? TEXT_EMBEDDING_3_SMALL_DIMENSIONS;
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
    if (embedding.length !== this.#expectedDimensions) {
      throw new Error(
        `OpenAI embedding response had ${embedding.length} dimensions; expected ${this.#expectedDimensions}`,
      );
    }

    return embedding;
  }
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}
