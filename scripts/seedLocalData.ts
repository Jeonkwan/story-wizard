import { wrapPcmAsWav, SAMPLE_RATE } from '../server/lib/wav.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import type { CatalogItem, Story, VoiceEntry } from '../shared/types.js';

export async function seedLocalData(targetDir = process.env.DATA_DIR || './data'): Promise<void> {
  const storage = new LocalStorageAdapter(targetDir);

  // 1. Voices
  const voices: VoiceEntry[] = [
    {
      id: 'prebuilt-kore',
      label: 'Kore (Warm Prebuilt)',
      source: 'prebuilt',
      gemini_voice_name: 'Kore',
      description: 'Warm, calm bedtime storytelling cadence with gentle pacing.',
      language_code: 'en-US',
      tags: ['warm', 'soothing', 'prebuilt', 'bedtime'],
      created_at: '2026-11-04T00:00:00.000Z',
    },
    {
      id: 'prebuilt-puck',
      label: 'Puck (Playful Prebuilt)',
      source: 'prebuilt',
      gemini_voice_name: 'Puck',
      description: 'Bright, cheerful, and curious tone ideal for energetic or inquisitive characters.',
      language_code: 'en-US',
      tags: ['bright', 'cheerful', 'prebuilt', 'character'],
      created_at: '2026-11-04T00:00:00.000Z',
    },
    {
      id: 'prebuilt-aoede',
      label: 'Aoede (Melodic Prebuilt)',
      source: 'prebuilt',
      gemini_voice_name: 'Aoede',
      description: 'Deep, melodic, resonant storytelling voice with lyrical nuance.',
      language_code: 'en-US',
      tags: ['melodic', 'deep', 'prebuilt', 'classic'],
      created_at: '2026-11-04T00:00:00.000Z',
    },
  ];
  await storage.saveVoices(voices);

  // 2. Story
  const storyId = '2026-11-04-sleepy-little-train';
  const story: Story = {
    id: storyId,
    status: 'published',
    title: 'The Sleepy Little Train',
    summary: 'A cozy little blue train journeys up the misty hillside under a sleepy crescent moon.',
    tags: ['bedtime', 'train', 'soothing', 'nature'],
    series_context: {
      series_id: 'little-tram-adventures',
      episode_number: 1,
      preferred_voice_id: 'prebuilt-kore',
    },
    characters: [
      {
        name: 'Bibi',
        traits: 'Gentle bell chime whistle, curious and sleepy little locomotive',
      },
    ],
    script_turns: [
      {
        turn_id: 1,
        speaker: 'Narrator',
        style: 'Warm, gentle bedtime storytelling tone',
        text: 'Once upon a time, at the edge of the quiet whispering woods, there rested a cheerful little train (which was painted bright blue). <short pause> The silver moon climbed into the velvety evening sky.',
      },
      {
        turn_id: 2,
        speaker: 'Bibi',
        style: 'Sleepy, soft bell tone whistle',
        text: 'Puff-puff! Are we ready to climb the star mountain track tonight? <sigh>',
      },
      {
        turn_id: 3,
        speaker: 'Narrator',
        style: 'Soothing and peaceful',
        text: 'The pine trees softly swayed as the train wheels began to roll along the peaceful valley track.',
      },
    ],
    voice_candidates: [
      {
        label: 'Cozy Engine Driver',
        description: 'Warm, raspy baritone storytelling voice with comforting rhythm',
        suggested_for: 'Narrator (Solo)',
      },
    ],
    audio_versions: [
      {
        version_id: 'v1-owl-solo',
        label: 'Grandpa Owl (Bedtime Solo)',
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {},
        },
        is_default: true,
        duration_sec: 2,
        audio_url: `/api/stories/${storyId}/audios/v1-owl-solo.wav`,
        created_at: '2026-11-04T00:00:00.000Z',
      },
    ],
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
  };
  await storage.saveStory(story);

  // 3. Audio synthesis: 2-second gentle sine-wave bell chime PCM buffer wrapped as WAV
  const durationSec = 2;
  const numSamples = SAMPLE_RATE * durationSec;
  const pcmBuffer = Buffer.alloc(numSamples * 2);
  const freq = 587.33; // D5 pleasant bell chime frequency

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Gentle exponential decay for bell chime
    const envelope = Math.exp(-1.8 * t);
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.25 * envelope;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    pcmBuffer.writeInt16LE(int16, i * 2);
  }

  const { wav } = wrapPcmAsWav(pcmBuffer);
  await storage.saveAudio(storyId, 'v1-owl-solo', wav);

  // 4. Catalog
  const catalog: CatalogItem[] = [
    {
      id: story.id,
      status: story.status,
      title: story.title,
      summary: story.summary,
      tags: story.tags,
      series_id: story.series_context?.series_id ?? null,
      episode_number: story.series_context?.episode_number ?? null,
      created_at: story.created_at,
      updated_at: story.updated_at,
      default_audio_url: story.audio_versions[0]?.audio_url ?? null,
      audio_versions_count: story.audio_versions.length,
    },
  ];
  await storage.saveCatalog(catalog);

  console.log(`Successfully seeded local data in ${targetDir}`);
}

// Run directly when invoked from CLI
if (process.argv[1] && process.argv[1].endsWith('seedLocalData.ts')) {
  seedLocalData().catch((err) => {
    console.error('Failed to seed local data:', err);
    process.exit(1);
  });
}
