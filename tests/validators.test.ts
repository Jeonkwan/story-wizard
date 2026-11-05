import { describe, it, expect } from 'vitest';
import { cleanTextForReader, APPROVED_VOCAL_TAGS } from '../shared/textClean';
import {
  validateWriterOutput,
  validateDirectorOutput,
  ValidationError,
  splitTextAtSentenceBoundaries,
} from '../server/lib/validators';
import type { ScriptTurn } from '../shared/types';

describe('Text Cleaner & Reader Formatting (shared/textClean.ts)', () => {
  it('cleanTextForReader removes inline vocal tags while preserving prose parentheses', () => {
    const input = 'Hello <short pause> world (painted blue)! <sigh>';
    const cleaned = cleanTextForReader(input);
    expect(cleaned).toBe('Hello world (painted blue)!');
  });

  it('approved vocal tags set contains exactly the 8 specified tags', () => {
    expect(APPROVED_VOCAL_TAGS.has('<sigh>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<laugh>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<chuckle>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<gasp>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<yawn>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<breath>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<short pause>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.has('<long pause>')).toBe(true);
    expect(APPROVED_VOCAL_TAGS.size).toBe(8);
  });
});

describe('Validator 1: Post-Writer Check (server/lib/validators.ts)', () => {
  it('rejects unknown speakers with a ValidationError', () => {
    expect(() => {
      validateWriterOutput({
        title: 'Bedtime Adventure',
        summary: 'A cozy tale of sleeping animals.',
        tags: ['bedtime', 'animals'],
        characters: [{ name: 'Bibi', traits: 'Gentle bell chime, sleepy' }],
        script_turns: [
          { turn_id: 1, speaker: 'Narrator', text: 'The sun was setting behind the hills.' },
          { turn_id: 2, speaker: 'AlienInvader', text: 'Take me to your leader!' },
        ],
      });
    }).toThrow(ValidationError);
  });

  it('rejects character named Narrator', () => {
    expect(() => {
      validateWriterOutput({
        title: 'Story',
        summary: 'Summary',
        tags: ['tag'],
        characters: [{ name: 'Narrator', traits: 'Speaks well' }],
        script_turns: [
          { turn_id: 1, speaker: 'Narrator', text: 'Once upon a time.' },
          { turn_id: 2, speaker: 'Narrator', text: 'The end.' },
        ],
      });
    }).toThrow(ValidationError);
  });

  it('re-indexes non-contiguous or missing turn IDs and lowercases/deduplicates tags', () => {
    const output = validateWriterOutput({
      title: '  The Cozy Cabin  ',
      summary: '  Warm hearth on a snowy night.  ',
      tags: ['COZY', 'snow', 'cozy', 'winter'],
      characters: [{ name: 'Bibi', traits: 'Tiny hedgehog' }],
      script_turns: [
        { turn_id: 42, speaker: 'narrator', text: 'The snow fell softly outside.' },
        { turn_id: 999, speaker: 'bibi', text: 'It is so warm by the fire.' },
      ],
    });

    expect(output.title).toBe('The Cozy Cabin');
    expect(output.summary).toBe('Warm hearth on a snowy night.');
    expect(output.tags).toEqual(['cozy', 'snow', 'winter']);
    expect(output.script_turns.length).toBe(2);
    expect(output.script_turns[0].turn_id).toBe(1);
    expect(output.script_turns[0].speaker).toBe('Narrator');
    expect(output.script_turns[1].turn_id).toBe(2);
    expect(output.script_turns[1].speaker).toBe('Bibi');
  });

  it('strips premature <sigh> tags from Writer output', () => {
    const output = validateWriterOutput({
      title: 'Quiet Stream',
      summary: 'Water bubbling under stars.',
      tags: ['nature'],
      characters: [{ name: 'Otter', traits: 'Playful whistle' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', text: 'The moon looked down. <sigh>' },
        { turn_id: 2, speaker: 'Otter', text: 'Goodnight stream! <short pause>' },
      ],
    });

    expect(output.script_turns[0].text).toBe('The moon looked down.');
    expect(output.script_turns[1].text).toBe('Goodnight stream!');
  });

  it('splitTextAtSentenceBoundaries splits text at sentence boundaries correctly', () => {
    const text = 'First sentence. Second sentence! Third question? Fourth sentence.';
    const chunks = splitTextAtSentenceBoundaries(text, 35);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(35);
    }
  });

  it('splits a 950-character multi-sentence turn into <= 600-character turns at sentence boundaries', () => {
    // Construct ~950 char text of distinct sentences
    const s1 = 'Deep in the heart of the whispering woods, the ancient pine trees swayed gently back and forth in the quiet evening breeze.';
    const s2 = 'Every single needle on every branch seemed to catch the silvery glow of the rising crescent moon, shimmering with a soft and comforting radiance that lit up the mossy undergrowth.';
    const s3 = 'Far below on the fragrant forest floor, little dormice were tucking themselves into tiny nests lined with dry heather, soft dandelion fluff, and thistle down.';
    const s4 = 'Not a single creature stirred as the silver dusk settled peacefully across the rolling hillside, bringing with it a profound stillness that promised hours of deep, restful sleep for everyone in the quiet valley.';
    const s5 = 'A lone cricket hummed a final lullaby before tucking its wings away for the peaceful starry night ahead.';
    const longText = `${s1} ${s2} ${s3} ${s4} ${s5}`;
    expect(longText.length).toBeGreaterThan(600);
    expect(longText.length).toBeLessThan(1000);

    const output = validateWriterOutput({
      title: 'The Great Forest',
      summary: 'Forest animals settling in.',
      tags: ['sleep', 'forest'],
      characters: [{ name: 'Owl', traits: 'Deep baritone' }],
      script_turns: [
        { turn_id: 1, speaker: 'Narrator', text: longText },
        { turn_id: 2, speaker: 'Owl', text: 'Hoo, goodnight forest.' },
      ],
    });

    // Turn 1 should have been split into multiple turns
    expect(output.script_turns.length).toBeGreaterThan(2);
    for (const turn of output.script_turns) {
      expect(turn.text.length).toBeLessThanOrEqual(600);
    }
    // Verify turn_ids are contiguous 1..N
    output.script_turns.forEach((turn, idx) => {
      expect(turn.turn_id).toBe(idx + 1);
    });
    // The last turn must be Owl's turn
    const lastTurn = output.script_turns[output.script_turns.length - 1];
    expect(lastTurn.speaker).toBe('Owl');
    expect(lastTurn.text).toBe('Hoo, goodnight forest.');
  });
});

describe('Validator 2: Post-Director Check (server/lib/validators.ts)', () => {
  const writerTurns: ScriptTurn[] = [
    {
      turn_id: 1,
      speaker: 'Narrator',
      style: '',
      text: 'The little engine slowly climbed up the steep mountain track.',
    },
    {
      turn_id: 2,
      speaker: 'Bibi',
      style: '',
      text: 'We are almost to the top of the star peak!',
    },
  ];

  it('normalizes <Short Pause> to lowercase and strips unauthorized <explosion> tag', () => {
    const directorInput = {
      script_turns: [
        {
          turn_id: 1,
          speaker: 'Narrator',
          style: 'Gentle rhythmic cadence',
          text: 'The little engine <Short Pause> slowly climbed up the steep mountain track. <explosion>',
        },
        {
          turn_id: 2,
          speaker: 'Bibi',
          style: 'Cheery and bright',
          text: 'We are almost to the top of the star peak! <gasp>',
        },
      ],
      voice_candidates: [
        {
          label: 'Storybook Narrator',
          description: 'Warm baritone with slow pacing',
          suggested_for: 'Narrator',
        },
      ],
    };

    const output = validateDirectorOutput(directorInput, writerTurns);

    expect(output.script_turns[0].text).toBe(
      'The little engine <short pause> slowly climbed up the steep mountain track.'
    );
    expect(output.script_turns[0].text).not.toContain('<explosion>');
    expect(output.script_turns[1].text).toBe(
      'We are almost to the top of the star peak! <gasp>'
    );
  });

  it('relocates parenthetical stage cues like (whispering) to style and strips from text', () => {
    const directorInput = {
      script_turns: [
        {
          turn_id: 1,
          speaker: 'Narrator',
          style: 'Soft bedtime tone',
          text: '(whispering) The little engine slowly climbed up the steep mountain track.',
        },
        {
          turn_id: 2,
          speaker: 'Bibi',
          style: 'Excited',
          text: 'We are almost to the top of the star peak! (gently)',
        },
      ],
      voice_candidates: [
        {
          label: 'Bedtime Narrator',
          description: 'Soothing voice',
          suggested_for: 'Narrator',
        },
      ],
    };

    const output = validateDirectorOutput(directorInput, writerTurns);

    expect(output.script_turns[0].style).toContain('whispering');
    expect(output.script_turns[0].text).toBe(
      'The little engine slowly climbed up the steep mountain track.'
    );
    expect(output.script_turns[0].text).not.toContain('(whispering)');

    expect(output.script_turns[1].style).toContain('gently');
    expect(output.script_turns[1].text).toBe(
      'We are almost to the top of the star peak!'
    );
    expect(output.script_turns[1].text).not.toContain('(gently)');
  });

  it('restores Writer prose if Director mutated words while keeping valid extracted tags', () => {
    const directorInput = {
      script_turns: [
        {
          turn_id: 1,
          speaker: 'Narrator',
          style: 'Epic tone',
          text: 'The tiny train engine ascended the massive snowy summit. <short pause>',
        },
        {
          turn_id: 2,
          speaker: 'Bibi',
          style: 'Thrilled',
          text: 'We reached the peak! <yawn>',
        },
      ],
      voice_candidates: [
        {
          label: 'Default Narrator',
          description: 'Warm voice',
          suggested_for: 'Narrator',
        },
      ],
    };

    const output = validateDirectorOutput(directorInput, writerTurns);

    // Director rewrote the words of turn 1 and turn 2!
    // Words must be restored to Writer's original words with the valid extracted tag appended
    expect(output.script_turns[0].text).toBe(
      'The little engine slowly climbed up the steep mountain track. <short pause>'
    );
    expect(output.script_turns[1].text).toBe(
      'We are almost to the top of the star peak! <yawn>'
    );
  });

  it('validates voice_candidates count and properties', () => {
    expect(() => {
      validateDirectorOutput(
        {
          script_turns: writerTurns,
          voice_candidates: [],
        },
        writerTurns
      );
    }).toThrow(ValidationError);

    expect(() => {
      validateDirectorOutput(
        {
          script_turns: writerTurns,
          voice_candidates: [
            { label: '', description: 'Desc', suggested_for: 'Narrator' },
          ],
        },
        writerTurns
      );
    }).toThrow(ValidationError);
  });
});
