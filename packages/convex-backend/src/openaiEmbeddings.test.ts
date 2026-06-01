import { afterEach, describe, expect, it } from 'vitest';
import { embedFindingSummary } from '../convex/openaiEmbeddings.js';

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

describe('Convex Finding embeddings', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  });

  it('requests text-embedding-3-small embeddings with the Convex OpenAI key', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> =
      [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      });
    };
    process.env.OPENAI_API_KEY = 'sk-test';

    const embedding = await embedFindingSummary('The cache key ignores the tenant id.');

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
