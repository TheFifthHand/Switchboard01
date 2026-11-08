/**
 * Project names that can be told apart: a new project whose name is taken
 * gets the next free number ("House Starter", "House Starter 2", "… 3").
 */

export const NAME_MAX = 80;

/** Collapse whitespace, trim, and cut to the name limit. */
export function cleanName(name: string, max = NAME_MAX): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, max);
}

const key = (name: string) => cleanName(name).toLocaleLowerCase();

/**
 * `base` if no name in `taken` matches it (ignoring case and extra spaces),
 * else `base 2`, `base 3`… the first that is free. Always at most `max`
 * characters (the base is shortened to make room for the number).
 */
export function uniqueName(base: string, taken: Iterable<string>, max = NAME_MAX): string {
  const used = new Set<string>();
  for (const t of taken) used.add(key(t));
  const clean = cleanName(base, max) || 'Untitled';
  if (!used.has(key(clean))) return clean;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${cleanName(clean, max - suffix.length)}${suffix}`;
    if (!used.has(key(candidate))) return candidate;
  }
}
