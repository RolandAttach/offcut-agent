import { getAddress } from 'ethers';

/**
 * Reading the environment, strictly.
 *
 * These scripts are handed addresses by a human at a terminal on the one day
 * the addresses matter, and a wrong one is not recoverable: a proxy initialised
 * with the wrong owner is a contract nobody owns, and `setToken` is a one-shot.
 * So every address is required to arrive EIP-55 checksummed, and the check is a
 * comparison rather than a parse.
 *
 * That distinction is the whole reason this file exists. `getAddress` does not
 * verify a checksum — it RECOMPUTES one, and hands back a perfectly formed
 * address for input that was all lower case or had a single character typed in
 * the wrong case. Comparing the input against what was recomputed is what turns
 * it back into a check, and it is the only cheap protection against a mistyped
 * address that still looks like an address.
 */
export type Env = Record<string, string | undefined>;

export function checksumOrThrow(value: string, label: string): string {
  const trimmed = value.trim();

  let recomputed: string;
  try {
    recomputed = getAddress(trimmed);
  } catch {
    throw new Error(`${label} is not an Ethereum address: ${JSON.stringify(trimmed)}`);
  }

  if (trimmed !== recomputed) {
    throw new Error(
      `${label} is not EIP-55 checksummed.\n` +
        `  given    ${trimmed}\n` +
        `  expected ${recomputed}\n` +
        '  Paste the address exactly as the explorer or wallet shows it. A lower-cased\n' +
        '  address is refused on purpose: the checksum is the only thing standing between\n' +
        '  a typo and an unrecoverable mistake.'
    );
  }

  return recomputed;
}

export function requireAddress(env: Env, name: string): string {
  const raw = env[name];
  if (!raw || raw.trim() === '') {
    throw new Error(`${name} is required. Set it to a checksummed 0x address and run again.`);
  }
  return checksumOrThrow(raw, name);
}

export function optionalAddress(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (!raw || raw.trim() === '') return undefined;
  return checksumOrThrow(raw, name);
}

/** Exactly "1" counts. Anything else — "true", "yes", "0" — does not, deliberately. */
export function flag(env: Env, name: string): boolean {
  return env[name] === '1';
}
