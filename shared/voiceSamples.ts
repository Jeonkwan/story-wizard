import type { VoiceSamplePreset } from './types.js';

export const MAX_VOICE_PREVIEW_CHARS = 320;

export const VOICE_SAMPLE_PRESETS: VoiceSamplePreset[] = [
  {
    id: 'playful-dialogue',
    label: 'Playful Dialogue (Default)',
    styleHint: 'Curious, playful storytelling with animated character dialogue',
    text: 'Little Pip peeked under the giant polka-dot mushroom and gasped. <gasp> "Whoa, Captain Whiskers! Is that a glowing goldenberry, or a giggling bumble-frog?" <chuckle>',
  },
  {
    id: 'magical-wonder',
    label: 'Magical Wonder',
    styleHint: 'Gentle, cozy, magical bedtime warmth',
    text: 'Soft silver starlight drifted across the quiet treetops like warm snow. <short pause> "Listen closely," whispered Grandpa Owl, <breath> "the sleepy forest is singing goodnight."',
  },
  {
    id: 'action-adventure',
    label: 'Bouncy Adventure',
    styleHint: 'Excited, bouncy adventure with heroic determination',
    text: 'Sir Barnaby adjusted his cardboard helmet and pointed his wooden spoon toward the pillow fortress! <breath> "Steady now, crew! Watch out for the tickle-dragon\'s fizzy bubbles!"',
  },
  {
    id: 'silly-comedy',
    label: 'Silly Character Mimicry',
    styleHint: 'Comedic theatrical contrast between grumpy boss and silly sidekick',
    text: '"Bananas?!" grumbled Boss Gruff, squinting through his shiny goggles. <sigh> "I specifically said zero bouncing monkeys in the pancake laboratory!" <laugh> "Oopsie!" squeaked tiny Bobo.',
  },
];

export const DEFAULT_VOICE_SAMPLE = VOICE_SAMPLE_PRESETS[0].text;
