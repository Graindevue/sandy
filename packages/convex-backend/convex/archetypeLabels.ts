const MAX_ARCHETYPE_LABEL_LENGTH = 56;
const MAX_ARCHETYPE_LABEL_WORDS = 8;

export function labelFromFindingSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return 'Unlabeled finding';
  }

  const words = normalized.split(' ').slice(0, MAX_ARCHETYPE_LABEL_WORDS);
  const label = words
    .join(' ')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (label.length <= MAX_ARCHETYPE_LABEL_LENGTH) {
    return label;
  }

  return `${label.slice(0, MAX_ARCHETYPE_LABEL_LENGTH - 3).trimEnd()}...`;
}
