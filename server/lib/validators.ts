import { APPROVED_VOCAL_TAGS, cleanTextForReader } from '../../shared/textClean.js';
import type { CharacterProfile, ScriptTurn, VoiceDesignCandidate } from '../../shared/types.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface WriterOutputInput {
  title?: string;
  summary?: string;
  tags?: string[];
  characters?: CharacterProfile[];
  script_turns?: Array<{
    turn_id?: number;
    speaker?: string;
    text?: string;
    style?: string;
  }>;
}

export interface ValidatedWriterOutput {
  title: string;
  summary: string;
  tags: string[];
  characters: CharacterProfile[];
  script_turns: ScriptTurn[];
}

export interface DirectorOutputInput {
  script_turns?: Array<{
    turn_id?: number;
    speaker?: string;
    text?: string;
    style?: string;
  }>;
  voice_candidates?: VoiceDesignCandidate[];
}

export interface ValidatedDirectorOutput {
  script_turns: ScriptTurn[];
  voice_candidates: VoiceDesignCandidate[];
}

/**
 * Splits long turn text (> 600 chars) at sentence boundaries (. ! ?) into chunks <= 600 chars.
 * Ensures any unbroken token > maxLen is hard-sliced so no chunk exceeds maxLen.
 */
export function splitTextAtSentenceBoundaries(text: string, maxLen = 600): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return [trimmed];

  const sentenceRegex = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
  const sentences = trimmed.match(sentenceRegex);
  if (!sentences || sentences.length <= 1) {
    // Fall back to word boundaries if no sentence punctuation
    const rawWords = trimmed.split(/\s+/).filter(Boolean);
    const words: string[] = [];
    for (const word of rawWords) {
      if (word.length > maxLen) {
        for (let i = 0; i < word.length; i += maxLen) {
          words.push(word.slice(i, i + maxLen));
        }
      } else {
        words.push(word);
      }
    }
    const chunks: string[] = [];
    let current = '';
    for (const word of words) {
      if (!current) {
        current = word;
      } else if ((current + ' ' + word).length <= maxLen) {
        current += ' ' + word;
      } else {
        chunks.push(current.trim());
        current = word;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (!current) {
      if (s.length > maxLen) {
        const subChunks = splitTextAtSentenceBoundaries(s, maxLen);
        chunks.push(...subChunks.slice(0, -1));
        current = subChunks[subChunks.length - 1];
      } else {
        current = s;
      }
    } else if ((current + ' ' + s).length <= maxLen) {
      current += ' ' + s;
    } else {
      chunks.push(current.trim());
      if (s.length > maxLen) {
        const subChunks = splitTextAtSentenceBoundaries(s, maxLen);
        chunks.push(...subChunks.slice(0, -1));
        current = subChunks[subChunks.length - 1];
      } else {
        current = s;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Normalizes words for comparison (strips vocal tags, parentheticals, punctuation, and case).
 */
function normalizeWords(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\([^)]+\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Validator 1: Post-Writer Check
 */
export function validateWriterOutput(raw: WriterOutputInput): ValidatedWriterOutput {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Writer output must be an object');
  }

  // 1. Title & summary
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) {
    throw new ValidationError('Story title must be a non-empty string');
  }

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) {
    throw new ValidationError('Story summary must be a non-empty string');
  }

  // Tags: non-empty string array, lowercased, deduplicated
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) {
    throw new ValidationError('Story tags must be a non-empty array of strings');
  }
  const tagsSet = new Set<string>();
  for (const tag of raw.tags) {
    if (typeof tag === 'string' && tag.trim()) {
      tagsSet.add(tag.trim().toLowerCase());
    }
  }
  if (tagsSet.size === 0) {
    throw new ValidationError('Story tags must contain at least one valid tag');
  }
  const tags = Array.from(tagsSet);

  // 2. Characters
  if (!Array.isArray(raw.characters)) {
    throw new ValidationError('Story characters must be an array');
  }

  const characters: CharacterProfile[] = [];
  const charMap = new Map<string, string>(); // lowercase -> canonical name

  for (const char of raw.characters) {
    if (!char || typeof char !== 'object') {
      throw new ValidationError('Each character must be an object with name and traits');
    }
    const name = typeof char.name === 'string' ? char.name.trim() : '';
    const traits = typeof char.traits === 'string' ? char.traits.trim() : '';
    if (!name || !traits) {
      throw new ValidationError('Character name and traits must be non-empty strings');
    }
    if (name.toLowerCase() === 'narrator') {
      throw new ValidationError('Character name cannot be "Narrator"');
    }
    if (charMap.has(name.toLowerCase())) {
      throw new ValidationError(`Duplicate character name: "${name}"`);
    }
    charMap.set(name.toLowerCase(), name);
    characters.push({ name, traits });
  }

  // 3. Script turns
  if (!Array.isArray(raw.script_turns) || raw.script_turns.length < 2) {
    throw new ValidationError('script_turns must contain at least 2 turns');
  }

  // 4, 5, 6, 7. Process turns
  const finalTurns: ScriptTurn[] = [];

  for (const turn of raw.script_turns) {
    if (!turn || typeof turn !== 'object') {
      throw new ValidationError('Each script turn must be an object');
    }

    const rawSpeaker = typeof turn.speaker === 'string' ? turn.speaker.trim() : '';
    if (!rawSpeaker) {
      throw new ValidationError('Turn speaker must be specified');
    }

    let canonicalSpeaker: string;
    if (rawSpeaker.toLowerCase() === 'narrator') {
      canonicalSpeaker = 'Narrator';
    } else if (charMap.has(rawSpeaker.toLowerCase())) {
      canonicalSpeaker = charMap.get(rawSpeaker.toLowerCase())!;
    } else {
      throw new ValidationError(`Unknown speaker: "${rawSpeaker}"`);
    }

    // Strip premature <...> tags from Writer output
    const rawText = typeof turn.text === 'string' ? turn.text : '';
    const strippedText = rawText
      .replace(/<[^>]+>/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!strippedText) {
      throw new ValidationError(`Turn for speaker "${canonicalSpeaker}" has empty text`);
    }

    // Auto-split any single turn whose text.length > 600 characters at sentence boundaries
    const splitTexts = splitTextAtSentenceBoundaries(strippedText, 600);
    for (const splitText of splitTexts) {
      finalTurns.push({
        turn_id: 0, // renumbered below
        speaker: canonicalSpeaker,
        style: typeof turn.style === 'string' ? turn.style.trim() : '',
        text: splitText,
      });
    }
  }

  // Re-index turn_id strictly contiguous 1..N
  finalTurns.forEach((turn, idx) => {
    turn.turn_id = idx + 1;
  });

  return {
    title,
    summary,
    tags,
    characters,
    script_turns: finalTurns,
  };
}

/**
 * Validator 2: Post-Director Check
 */
export function validateDirectorOutput(
  rawDirector: DirectorOutputInput,
  writerTurns: ScriptTurn[]
): ValidatedDirectorOutput {
  if (!rawDirector || typeof rawDirector !== 'object') {
    throw new ValidationError('Director output must be an object');
  }

  const directedTurns = rawDirector.script_turns;
  if (!Array.isArray(directedTurns)) {
    throw new ValidationError('Director script_turns must be an array');
  }

  // 1. directedTurns.length MUST equal writerTurns.length
  if (directedTurns.length !== writerTurns.length) {
    throw new ValidationError(
      `Director turn count (${directedTurns.length}) does not match Writer turn count (${writerTurns.length})`
    );
  }

  const finalTurns: ScriptTurn[] = [];

  for (let i = 0; i < writerTurns.length; i++) {
    const writerTurn = writerTurns[i];
    const directedTurn = directedTurns[i];

    if (!directedTurn || typeof directedTurn !== 'object') {
      throw new ValidationError(`Director turn at index ${i} is invalid`);
    }

    // Verify turn_id and speaker
    if (
      directedTurn.turn_id !== undefined &&
      Number(directedTurn.turn_id) !== writerTurn.turn_id
    ) {
      throw new ValidationError(
        `Director turn_id ${directedTurn.turn_id} does not match expected ${writerTurn.turn_id} at index ${i}`
      );
    }

    const dirSpeaker = (directedTurn.speaker || '').trim().toLowerCase();
    const wrtSpeaker = writerTurn.speaker.trim().toLowerCase();
    if (dirSpeaker && dirSpeaker !== wrtSpeaker) {
      throw new ValidationError(
        `Director speaker "${directedTurn.speaker}" does not match Writer speaker "${writerTurn.speaker}" at index ${i}`
      );
    }

    let style = (directedTurn.style || '').trim();
    let text = (directedTurn.text || '').trim();

    // 4. Parenthetical Stage Direction Sanitizer:
    // Extract any parentheticals (whispering) that were NOT present in writerTurn.text
    const writerParentheticals = new Set<string>();
    const writerMatches = writerTurn.text.match(/\(([^)]+)\)/g) || [];
    for (const m of writerMatches) {
      writerParentheticals.add(m);
    }

    const directedParentheticals = text.match(/\(([^)]+)\)/g) || [];
    const injectedCues: string[] = [];
    for (const p of directedParentheticals) {
      if (!writerParentheticals.has(p)) {
        // Injected by Director — extract inner cue and strip from text
        const cue = p.slice(1, -1).trim();
        if (cue) injectedCues.push(cue);
        text = text.replace(p, '');
      }
    }

    if (injectedCues.length > 0) {
      const cueStr = injectedCues.join(', ');
      style = style ? `${style}, ${cueStr}` : cueStr;
    }

    // 3. Tag Whitelist Filter & Normalization
    // Find every <...> match in text
    const extractedValidTags: string[] = [];
    text = text.replace(/<([^>]+)>/g, (_match, inner) => {
      const normalizedTag = `<${inner.trim().toLowerCase()}>`;
      if (APPROVED_VOCAL_TAGS.has(normalizedTag)) {
        extractedValidTags.push(normalizedTag);
        return normalizedTag;
      }
      // Strip unauthorized tag
      return '';
    });
    text = text.replace(/\s{2,}/g, ' ').trim();

    // 2. Spoken Text Integrity Check:
    // Compare normalized words of directedTurn against writerTurn
    const normalizedDirectedWords = normalizeWords(text);
    const normalizedWriterWords = normalizeWords(writerTurn.text);

    if (normalizedDirectedWords !== normalizedWriterWords) {
      // Director mutated words! Restore writerTurn.text + valid extracted tags
      if (extractedValidTags.length > 0) {
        text = `${writerTurn.text} ${extractedValidTags.join(' ')}`.trim();
      } else {
        text = writerTurn.text;
      }
    }

    // 5. Ensure turn.style is non-empty (fallback: "Warm, gentle storytelling tone") and <= 200 chars
    if (!style) {
      style = 'Warm, gentle storytelling tone';
    }
    if (style.length > 200) {
      style = style.slice(0, 200).trim();
    }

    finalTurns.push({
      turn_id: writerTurn.turn_id,
      speaker: writerTurn.speaker,
      style,
      text,
    });
  }

  // 6. Ensure voice_candidates has 1..3 valid { label, description, suggested_for } entries
  const candidates = rawDirector.voice_candidates;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) {
    throw new ValidationError('voice_candidates must contain between 1 and 3 entries');
  }

  const validatedCandidates: VoiceDesignCandidate[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') {
      throw new ValidationError('Each voice_candidate must be an object');
    }
    const label = typeof c.label === 'string' ? c.label.trim() : '';
    const description = typeof c.description === 'string' ? c.description.trim() : '';
    const suggested_for = typeof c.suggested_for === 'string' ? c.suggested_for.trim() : '';

    if (!label || !description || !suggested_for) {
      throw new ValidationError(
        'voice_candidate label, description, and suggested_for must be non-empty strings'
      );
    }

    validatedCandidates.push({ label, description, suggested_for });
  }

  return {
    script_turns: finalTurns,
    voice_candidates: validatedCandidates,
  };
}

/**
 * Validator for manual admin edits (PUT /api/admin/stories/:id).
 * Enforces all Validator 1 invariants while:
 * - Normalizing case inside <...> tags.
 * - Preserving approved vocal tags (APPROVED_VOCAL_TAGS).
 * - Stripping ONLY unauthorized <...> tags (e.g. <cough_loudly>).
 * - Verifying cleanTextForReader(turn.text) is non-empty.
 * - Preserving/trimming turn.style (max 200 chars).
 */
export function validateManualStoryEdit(raw: WriterOutputInput): ValidatedWriterOutput {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Story edit payload must be an object');
  }

  // 1. Title & summary
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) {
    throw new ValidationError('Story title must be a non-empty string');
  }

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) {
    throw new ValidationError('Story summary must be a non-empty string');
  }

  // Tags: non-empty string array, lowercased, deduplicated
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) {
    throw new ValidationError('Story tags must be a non-empty array of strings');
  }
  const tagsSet = new Set<string>();
  for (const tag of raw.tags) {
    if (typeof tag === 'string' && tag.trim()) {
      tagsSet.add(tag.trim().toLowerCase());
    }
  }
  if (tagsSet.size === 0) {
    throw new ValidationError('Story tags must contain at least one valid tag');
  }
  const tags = Array.from(tagsSet);

  // 2. Characters
  if (!Array.isArray(raw.characters)) {
    throw new ValidationError('Story characters must be an array');
  }

  const characters: CharacterProfile[] = [];
  const charMap = new Map<string, string>(); // lowercase -> canonical name

  for (const char of raw.characters) {
    if (!char || typeof char !== 'object') {
      throw new ValidationError('Each character must be an object with name and traits');
    }
    const name = typeof char.name === 'string' ? char.name.trim() : '';
    const traits = typeof char.traits === 'string' ? char.traits.trim() : '';
    if (!name || !traits) {
      throw new ValidationError('Character name and traits must be non-empty strings');
    }
    if (name.toLowerCase() === 'narrator') {
      throw new ValidationError('Character name cannot be "Narrator"');
    }
    if (charMap.has(name.toLowerCase())) {
      throw new ValidationError(`Duplicate character name: "${name}"`);
    }
    charMap.set(name.toLowerCase(), name);
    characters.push({ name, traits });
  }

  // 3. Script turns
  if (!Array.isArray(raw.script_turns) || raw.script_turns.length < 2) {
    throw new ValidationError('script_turns must contain at least 2 turns');
  }

  const finalTurns: ScriptTurn[] = [];

  for (const turn of raw.script_turns) {
    if (!turn || typeof turn !== 'object') {
      throw new ValidationError('Each script turn must be an object');
    }

    const rawSpeaker = typeof turn.speaker === 'string' ? turn.speaker.trim() : '';
    if (!rawSpeaker) {
      throw new ValidationError('Turn speaker must be specified');
    }

    let canonicalSpeaker: string;
    if (rawSpeaker.toLowerCase() === 'narrator') {
      canonicalSpeaker = 'Narrator';
    } else if (charMap.has(rawSpeaker.toLowerCase())) {
      canonicalSpeaker = charMap.get(rawSpeaker.toLowerCase())!;
    } else {
      throw new ValidationError(`Unknown speaker: "${rawSpeaker}"`);
    }

    // Process text: normalize case in <...>, preserve approved vocal tags, strip unauthorized tags
    const rawText = typeof turn.text === 'string' ? turn.text : '';
    let sanitizedText = rawText.replace(/<([^>]+)>/g, (_match, inner) => {
      const normalizedTag = `<${inner.trim().toLowerCase()}>`;
      if (APPROVED_VOCAL_TAGS.has(normalizedTag)) {
        return normalizedTag;
      }
      return '';
    });
    sanitizedText = sanitizedText.replace(/\s{2,}/g, ' ').trim();

    // Verify cleanTextForReader(sanitizedText) is non-empty
    const readableText = cleanTextForReader(sanitizedText);
    if (!readableText) {
      throw new ValidationError(`Turn for speaker "${canonicalSpeaker}" has empty text`);
    }

    // Process style: trim and limit to 200 chars
    let style = typeof turn.style === 'string' ? turn.style.trim() : '';
    if (style.length > 200) {
      style = style.slice(0, 200).trim();
    }

    // Auto-split if length > 600 chars at sentence boundaries
    const splitTexts = splitTextAtSentenceBoundaries(sanitizedText, 600);
    for (const splitText of splitTexts) {
      finalTurns.push({
        turn_id: 0, // renumbered below
        speaker: canonicalSpeaker,
        style,
        text: splitText,
      });
    }
  }

  // Re-index turn_id contiguous 1..N
  finalTurns.forEach((turn, idx) => {
    turn.turn_id = idx + 1;
  });

  return {
    title,
    summary,
    tags,
    characters,
    script_turns: finalTurns,
  };
}
