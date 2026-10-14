import { describe, expect, it } from 'vitest';
import { readElevenLabsConfig, synthesize, wordsFromAlignment } from './narrate-elevenlabs';

const config = { apiKey: 'sk-test-secret-value', voiceId: 'voice123', modelId: 'eleven_multilingual_v2' };

/** Alignment with one character every 100 ms. */
function alignment(text: string) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i / 10),
    character_end_times_seconds: characters.map((_, i) => (i + 1) / 10),
  };
}

describe('readElevenLabsConfig', () => {
  it('refuses to run without the key and voice id, naming only the missing variables', () => {
    expect(() => readElevenLabsConfig({})).toThrow(/ELEVENLABS_API_KEY.*ELEVENLABS_VOICE_ID/);
    expect(() => readElevenLabsConfig({ ELEVENLABS_API_KEY: 'sk-test-secret-value' })).toThrow(/ELEVENLABS_VOICE_ID/);
    try {
      readElevenLabsConfig({ ELEVENLABS_API_KEY: 'sk-test-secret-value' });
    } catch (error) {
      expect(String(error)).not.toContain('sk-test-secret-value');
    }
  });

  it('defaults the model', () => {
    expect(readElevenLabsConfig({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' })).toEqual({
      apiKey: 'k',
      voiceId: 'v',
      modelId: 'eleven_multilingual_v2',
    });
  });
});

describe('wordsFromAlignment', () => {
  it('groups characters into words spanning first start to last end', () => {
    expect(wordsFromAlignment(alignment('One  project.\nMany'))).toEqual([
      { w: 'One', start: 0, end: 0.3 },
      { w: 'project.', start: 0.5, end: 1.3 },
      { w: 'Many', start: 1.4, end: 1.8 },
    ]);
  });

  it('returns no words for an empty alignment', () => {
    expect(wordsFromAlignment({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toEqual([]);
  });
});

describe('synthesize', () => {
  it('POSTs the text with timestamps and decodes audio and word timings', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(
        JSON.stringify({ audio_base64: Buffer.from('ID3-fake-mp3').toString('base64'), alignment: alignment('Hi there') }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await synthesize('Hi there', config, fakeFetch);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice123/with-timestamps?output_format=mp3_44100_128',
    );
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('xi-api-key')).toBe('sk-test-secret-value');
    expect(JSON.parse(String(call.init.body))).toEqual({
      text: 'Hi there',
      model_id: 'eleven_multilingual_v2',
      output_format: 'mp3_44100_128',
    });
    expect(result.audio.toString()).toBe('ID3-fake-mp3');
    expect(result.words.map((w) => w.w)).toEqual(['Hi', 'there']);
  });

  it('reports an HTTP failure without echoing the key', async () => {
    const fakeFetch = (async () => new Response('{"detail":"invalid voice"}', { status: 404 })) as typeof fetch;
    const failure = synthesize('Hi', config, fakeFetch);
    await expect(failure).rejects.toThrow(/ElevenLabs.*404.*invalid voice/);
    await expect(failure).rejects.not.toThrow(/sk-test-secret-value/);
  });
});
