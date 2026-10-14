/**
 * First-cut narration with ElevenLabs text-to-speech. For each scene it sends the
 * scene's lines from docs/DEMO-SCRIPT.md to `text-to-speech/{voice}/with-timestamps`,
 * writes public/audio/scene-NN.mp3 plus scene-NN.words.json (word timings derived
 * from the character alignment), then rebuilds narration.json with
 * scripts/build-narration-json.ts so durations are measured from the new files.
 *
 * Needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in video/.env (git-ignored) or
 * the environment; ELEVENLABS_MODEL_ID is optional. The key is never printed.
 *
 * Usage: pnpm narration:elevenlabs [--only 1,5]   (scene numbers; default all)
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Word } from '../src/data';
import { buildAndWrite, PUBLIC_DIR, VIDEO_ROOT, writeWordsSidecar } from './build-narration-json';
import { readSceneTexts, SCENES, sceneStem } from './script-text';

const API = 'https://api.elevenlabs.io/v1';
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
}

/** Reads the ElevenLabs settings; throws naming (never echoing) missing variables. */
export function readElevenLabsConfig(env: Record<string, string | undefined>): ElevenLabsConfig {
  const missing = ['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'].filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run: set ${missing.join(' and ')} in video/.env (git-ignored) or the environment. ` +
        'Voice ids are listed at https://elevenlabs.io/app/voice-lab.',
    );
  }
  return {
    apiKey: env.ELEVENLABS_API_KEY!.trim(),
    voiceId: env.ELEVENLABS_VOICE_ID!.trim(),
    modelId: env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL,
  };
}

const AlignmentSchema = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});
type Alignment = z.infer<typeof AlignmentSchema>;

const ResponseSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: AlignmentSchema.nullish(),
});

/** Word timings from ElevenLabs character alignment: a word runs from its first character's start to its last's end. */
export function wordsFromAlignment(alignment: Alignment): Word[] {
  const words: Word[] = [];
  let current: Word | undefined;
  alignment.characters.forEach((char, i) => {
    if (/\s/.test(char)) {
      current = undefined;
      return;
    }
    const start = alignment.character_start_times_seconds[i] ?? 0;
    const end = alignment.character_end_times_seconds[i] ?? start;
    if (current) {
      current.w += char;
      current.end = end;
    } else {
      current = { w: char, start, end };
      words.push(current);
    }
  });
  return words;
}

/** One text-to-speech call. `fetchImpl` is injectable so tests never reach the API. */
export async function synthesize(
  text: string,
  config: ElevenLabsConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ audio: Buffer; words: Word[] }> {
  const url = `${API}/text-to-speech/${encodeURIComponent(config.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'xi-api-key': config.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ text, model_id: config.modelId, output_format: OUTPUT_FORMAT }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`ElevenLabs text-to-speech failed: HTTP ${response.status} ${detail}`);
  }
  const body = ResponseSchema.parse(await response.json());
  return {
    audio: Buffer.from(body.audio_base64, 'base64'),
    words: body.alignment ? wordsFromAlignment(body.alignment) : [],
  };
}

/** `--only 1,5` → [1, 5]; undefined when absent. */
function parseOnly(argv: string[]): number[] | undefined {
  const index = argv.findIndex((arg) => arg === '--only' || arg.startsWith('--only='));
  if (index < 0) return undefined;
  const arg = argv[index]!;
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[index + 1];
  const numbers = (value ?? '').split(',').filter(Boolean).map(Number);
  const valid = new Set(SCENES.map((scene) => scene.number));
  if (numbers.length === 0 || numbers.some((n) => !valid.has(n))) {
    throw new Error(`--only takes scene numbers ${[...valid].join(',')}; got "${value ?? ''}"`);
  }
  return numbers;
}

async function main(): Promise<void> {
  const envFile = join(VIDEO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = readElevenLabsConfig(process.env);
  const only = parseOnly(process.argv.slice(2));
  const scenes = readSceneTexts().filter((scene) => !only || only.includes(scene.number));

  const audioDir = join(PUBLIC_DIR, 'audio');
  mkdirSync(audioDir, { recursive: true });
  console.log(`ElevenLabs: ${scenes.length} scene(s), voice ${config.voiceId}, model ${config.modelId}`);
  for (const scene of scenes) {
    const file = join(audioDir, `${sceneStem(scene.number)}.mp3`);
    const { audio, words } = await synthesize(scene.text, config);
    writeFileSync(file, audio);
    writeWordsSidecar(file, 'elevenlabs', words);
    console.log(`  ${sceneStem(scene.number)}.mp3 (${scene.id}): ${words.length} words`);
  }
  console.log('Rebuilding narration.json from public/audio:');
  buildAndWrite();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
