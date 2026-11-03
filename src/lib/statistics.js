// Tie-safe ROC AUC: probability a randomly selected positive has a higher score
// than a randomly selected negative. Ties contribute 0.5.
export function rocAuc(rows, scoreKey = 'p', outcomeKey = 'win') {
  const positives = rows.filter(r => Boolean(r[outcomeKey]));
  const negatives = rows.filter(r => !r[outcomeKey]);
  if (!positives.length || !negatives.length) return null;
  let concordant = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      const a = positive[scoreKey], b = negative[scoreKey];
      concordant += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }
  return concordant / (positives.length * negatives.length);
}
