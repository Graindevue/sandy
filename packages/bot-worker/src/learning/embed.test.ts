import { describe, expect, it } from 'vitest';
import { FINDING_EMBEDDING_DIMENSIONS, OllamaFindingEmbedder } from './embed.js';

describe('OllamaFindingEmbedder', () => {
  it('requests nomic-embed-text embeddings for Finding summaries', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> =
      [];
    const vector = Array.from({ length: FINDING_EMBEDDING_DIMENSIONS }, (_, index) => index / 1000);
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ embedding: vector }), { status: 200 });
    };
    const embedder = new OllamaFindingEmbedder({
      fetch: fakeFetch,
    });

    const embedding = await embedder.embedFindingSummary('The cache key ignores the tenant id.');

    expect(embedding).toEqual(vector);
    expect(embedding).toHaveLength(FINDING_EMBEDDING_DIMENSIONS);
    expect(calls[0]?.input).toBe('http://127.0.0.1:11434/api/embeddings');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({
      'content-type': 'application/json',
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      model: 'nomic-embed-text',
      prompt: 'The cache key ignores the tenant id.',
    });
  });

  it('allows the embedding dimensions to be overridden', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    const embedder = new OllamaFindingEmbedder({
      fetch: fakeFetch,
      dimensions: 3,
    });

    await expect(embedder.embedFindingSummary('summary')).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it('uses a configured Ollama host', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> =
      [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 });
    };
    const embedder = new OllamaFindingEmbedder({
      fetch: fakeFetch,
      host: 'http://ollama.internal:11434/',
      dimensions: 3,
    });

    await embedder.embedFindingSummary('The cache key ignores the tenant id.');

    expect(calls[0]?.input).toBe('http://ollama.internal:11434/api/embeddings');
  });

  it('reports Ollama HTTP errors', async () => {
    const embedder = new OllamaFindingEmbedder({
      fetch: async () => new Response('model not found', { status: 404 }),
    });

    await expect(embedder.embedFindingSummary('summary')).rejects.toThrow(
      /Ollama embedding request failed with 404: model not found/,
    );
  });

  it('reports unreachable Ollama hosts', async () => {
    const embedder = new OllamaFindingEmbedder({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      },
    });

    await expect(embedder.embedFindingSummary('summary')).rejects.toThrow(
      /Ollama embedding request failed: connect ECONNREFUSED 127\.0\.0\.1:11434/,
    );
  });
});
