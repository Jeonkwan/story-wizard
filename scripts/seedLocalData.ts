import { wrapPcmAsWav, SAMPLE_RATE } from '../server/lib/wav.js';
import { LocalStorageAdapter } from '../server/storage/localStorage.js';
import type { CatalogItem, Story, VoiceEntry } from '../shared/types.js';

function generateChimeWav(freq: number, durationSec = 2): Buffer {
  const numSamples = SAMPLE_RATE * durationSec;
  const pcmBuffer = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-1.8 * t);
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.25 * envelope;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    pcmBuffer.writeInt16LE(int16, i * 2);
  }
  return wrapPcmAsWav(pcmBuffer).wav;
}

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

  // 2. Story 1: The Sleepy Little Train (Ep 1)
  const story1Id = '2026-11-04-sleepy-little-train';
  const story1: Story = {
    id: story1Id,
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
        audio_url: `/api/stories/${story1Id}/audios/v1-owl-solo.wav`,
        created_at: '2026-11-04T00:00:00.000Z',
      },
      {
        version_id: 'v2-aoede-solo',
        label: 'Aoede (Melodic Solo)',
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-aoede',
          character_voices: {},
        },
        is_default: false,
        duration_sec: 2,
        audio_url: `/api/stories/${story1Id}/audios/v2-aoede-solo.wav`,
        created_at: '2026-11-04T01:00:00.000Z',
      },
    ],
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
  };
  await storage.saveStory(story1);
  await storage.saveAudio(story1Id, 'v1-owl-solo', generateChimeWav(587.33, 2));
  await storage.saveAudio(story1Id, 'v2-aoede-solo', generateChimeWav(440.0, 2));

  // 3. Story 2: The Star Mountain Express (Ep 2)
  const story2Id = '2026-11-05-star-mountain-express';
  const story2: Story = {
    id: story2Id,
    status: 'published',
    title: 'The Star Mountain Express',
    summary: 'Bibi and the night express climb through sleepy clouds toward the twinkling constellation peak.',
    tags: ['bedtime', 'train', 'stars'],
    series_context: {
      series_id: 'little-tram-adventures',
      episode_number: 2,
      preferred_voice_id: 'prebuilt-puck',
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
        style: 'Gentle and mystical bedtime tone',
        text: 'Higher and higher the little train climbed, as gentle stardust sparkled across the rails. <short pause> The night sky wrapped the mountain in calm stillness.',
      },
      {
        turn_id: 2,
        speaker: 'Bibi',
        style: 'Quiet awe',
        text: 'Look at the golden constellations resting upon the peak! <whisper>',
      },
    ],
    voice_candidates: [],
    audio_versions: [
      {
        version_id: 'v1-kore-solo',
        label: 'Kore (Bedtime Solo)',
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-kore',
          character_voices: {},
        },
        is_default: true,
        duration_sec: 2,
        audio_url: `/api/stories/${story2Id}/audios/v1-kore-solo.wav`,
        created_at: '2026-11-05T00:00:00.000Z',
      },
    ],
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
  };
  await storage.saveStory(story2);
  await storage.saveAudio(story2Id, 'v1-kore-solo', generateChimeWav(523.25, 2));

  // 4. Story 3: The Whispering Owl (Standalone)
  const story3Id = '2026-11-06-whispering-owl';
  const story3: Story = {
    id: story3Id,
    status: 'published',
    title: 'The Whispering Owl',
    summary: 'A gentle barn owl glides quietly across the moonlit meadow softly hooting goodnight.',
    tags: ['bedtime', 'owl', 'nature'],
    series_context: null,
    characters: [],
    script_turns: [
      {
        turn_id: 1,
        speaker: 'Narrator',
        style: 'Peaceful bedtime cadence',
        text: 'Over the silvery clover fields, Orin the owl fluttered his velvet wings without making a sound. <sigh> Sleep now, little meadow, sleep.',
      },
      {
        turn_id: 2,
        speaker: 'Narrator',
        style: 'Soft and rhythmic',
        text: 'The moon beamed warmly through the leafy branches, lighting dreams for all the creatures below. <long pause>',
      },
    ],
    voice_candidates: [],
    audio_versions: [
      {
        version_id: 'v1-puck-solo',
        label: 'Puck (Gentle Solo)',
        casting: {
          mode: 'solo',
          narrator_voice_id: 'prebuilt-puck',
          character_voices: {},
        },
        is_default: true,
        duration_sec: 2,
        audio_url: `/api/stories/${story3Id}/audios/v1-puck-solo.wav`,
        created_at: '2026-11-06T00:00:00.000Z',
      },
    ],
    created_at: '2026-11-06T00:00:00.000Z',
    updated_at: '2026-11-06T00:00:00.000Z',
  };
  await storage.saveStory(story3);
  await storage.saveAudio(story3Id, 'v1-puck-solo', generateChimeWav(659.25, 2));

  // 5. Catalog
  const catalog: CatalogItem[] = [
    {
      id: story1.id,
      status: story1.status,
      title: story1.title,
      summary: story1.summary,
      tags: story1.tags,
      series_id: story1.series_context?.series_id ?? null,
      episode_number: story1.series_context?.episode_number ?? null,
      created_at: story1.created_at,
      updated_at: story1.updated_at,
      default_audio_url: story1.audio_versions[0]?.audio_url ?? null,
      audio_versions_count: story1.audio_versions.length,
    },
    {
      id: story2.id,
      status: story2.status,
      title: story2.title,
      summary: story2.summary,
      tags: story2.tags,
      series_id: story2.series_context?.series_id ?? null,
      episode_number: story2.series_context?.episode_number ?? null,
      created_at: story2.created_at,
      updated_at: story2.updated_at,
      default_audio_url: story2.audio_versions[0]?.audio_url ?? null,
      audio_versions_count: story2.audio_versions.length,
    },
    {
      id: story3.id,
      status: story3.status,
      title: story3.title,
      summary: story3.summary,
      tags: story3.tags,
      series_id: null,
      episode_number: null,
      created_at: story3.created_at,
      updated_at: story3.updated_at,
      default_audio_url: story3.audio_versions[0]?.audio_url ?? null,
      audio_versions_count: story3.audio_versions.length,
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
