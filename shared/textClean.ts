export const APPROVED_VOCAL_TAGS = new Set<string>([
  '<sigh>',
  '<laugh>',
  '<chuckle>',
  '<gasp>',
  '<yawn>',
  '<breath>',
  '<short pause>',
  '<long pause>',
]);

/**
 * Used by StoryReader UI ONLY — removes inline vocal tags like <short pause>
 * while preserving normal prose parentheses like "(painted bright blue)"!
 */
export function cleanTextForReader(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
