import { describe, expect, it } from 'vitest';
import { OpenAIFindingEmbedder } from './embed.js';

describe('OpenAIFindingEmbedder', () => {
  it('requests text-embedding-3-small embeddings for Finding summaries', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> =
      [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      });
    };
    const embedder = new OpenAIFindingEmbedder({
      apiKey: 'sk-test',
      fetch: fakeFetch,
      expectedDimensions: 3,
    });

    const embedding = await embedder.embedFindingSummary('The cache key ignores the tenant id.');

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(calls[0]?.input).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: 'The cache key ignores the tenant id.',
    });
  });
});
