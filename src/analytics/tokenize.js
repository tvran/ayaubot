const stopwords = new Set([
  'а', 'ал', 'без', 'бен', 'бір', 'бы', 'был', 'была', 'были', 'было', 'в', 'во', 'вот', 'все', 'да',
  'для', 'до', 'его', 'ее', 'если', 'же', 'за', 'и', 'из', 'или', 'к', 'как', 'мен', 'мы', 'на', 'не',
  'но', 'ну', 'о', 'об', 'ол', 'он', 'она', 'они', 'от', 'по', 'с', 'со', 'так', 'там', 'то', 'ты',
  'у', 'уже', 'что', 'это', 'я', 'the', 'and', 'you', 'are', 'for', 'that', 'this', 'with'
]);

export const normalizeWord = (word) =>
  word
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/^['’`]+|['’`]+$/g, '');

export const tokenizeText = (text = '') => {
  if (!text || text.startsWith('/')) return [];

  const words = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’`-]*/gu) || [];

  return words
    .map(normalizeWord)
    .filter((word) => word.length >= 3 && !stopwords.has(word));
};

export const wordCounts = (words) =>
  words.reduce((counts, word) => {
    counts.set(word, (counts.get(word) || 0) + 1);
    return counts;
  }, new Map());
