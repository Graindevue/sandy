const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: unknown;
  }>;
}

export async function embedFindingSummary(summary: string): Promise<number[]> {
  const response = await globalFetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openAiApiKeyFromEnv()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
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
  return embedding;
}

function openAiApiKeyFromEnv(): string {
  const apiKey = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to embed Finding summaries');
  }
  return apiKey;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function globalFetch(input: string, init: Parameters<FetchLike>[1]): ReturnType<FetchLike> {
  return (globalThis as unknown as { fetch: FetchLike }).fetch(input, init);
}
