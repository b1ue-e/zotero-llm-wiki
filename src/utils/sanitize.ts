/**
 * Convert a paper title into a safe filename slug.
 * Replaces filesystem-unsafe characters, truncates to 100 chars,
 * and appends a short hash to avoid collisions.
 */
export function titleToSlug(title: string): string {
  const hash = simpleHash(title).slice(0, 8);
  let slug = title
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 100);

  return `${slug}-${hash}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}
