/**
 * Which store this process talks to, decided from the environment alone.
 *
 * One variable decides it, and its absence is the old behaviour byte for byte:
 * §7 of the specification says the first release is LOCAL, and that stays the
 * default. OFFCUT_API_URL is how someone says "my store is over there" - the
 * case the live site creates the moment it mints a key, because that key
 * exists in the server's database and in no file on the caller's machine.
 *
 * It lives in its own file, importing nothing, so the decision can be tested
 * without starting a server or opening a database - and so index.ts can read
 * it before it imports anything that would.
 */

export type StoreChoice =
  | { kind: 'local' }
  | { kind: 'remote'; baseUrl: string }
  | { kind: 'refused'; message: string };

export function chooseStore(env: Record<string, string | undefined>): StoreChoice {
  const raw = env.OFFCUT_API_URL?.trim();

  // An empty value is treated as unset rather than as an error: `-e
  // OFFCUT_API_URL=` is how a client config disables a variable it used to
  // set, and failing there would strand someone who is going back to local.
  if (!raw) return { kind: 'local' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      kind: 'refused',
      message: `OFFCUT_API_URL is not a URL: "${raw}". It should look like https://offcut.tech`,
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      kind: 'refused',
      message: `OFFCUT_API_URL must be http or https, not "${parsed.protocol}". It should look like https://offcut.tech`,
    };
  }

  return { kind: 'remote', baseUrl: raw };
}
