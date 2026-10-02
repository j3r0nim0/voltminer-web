/** Origin allowlist for the experimental WS→TLS stratum bridge. */

export function parseAllowlist(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export const DEFAULT_ORIGINS = [
  'https://j3r0nim0.github.io',
  'https://voltminer.net',
  'https://www.voltminer.net',
  'https://web.voltminer.net',
];

/** Local preview (python3 -m http.server) is allowed on loopback only. */
export function originAllowed(origin, allowlist = new Set(DEFAULT_ORIGINS)) {
  if (!origin) return false;
  if (allowlist.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (loopback && u.protocol === 'http:') return true;
  } catch {
    return false;
  }
  return false;
}
