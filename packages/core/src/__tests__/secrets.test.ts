/**
 * Encryption for the one secret that has to be stored rather than hashed.
 *
 * The workspace's OpenRouter key is readable by design — verification means
 * presenting it — so these tests are about the three ways that goes wrong:
 *
 *   it is stored in plaintext because encryption was "optional"
 *   it decrypts to garbage under the wrong key and gets used anyway
 *   it ends up in an error message on its way to a log
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  requireSecretKey,
  secretHint,
  secretsConfigured,
} from '../secrets';

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');

const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

let original: string | undefined;

beforeEach(() => {
  original = process.env.OFFCUT_SECRET_KEY;
  process.env.OFFCUT_SECRET_KEY = KEY_A;
});

afterEach(() => {
  if (original === undefined) delete process.env.OFFCUT_SECRET_KEY;
  else process.env.OFFCUT_SECRET_KEY = original;
});

// ---------------------------------------------------------------------------
describe('A stored credential survives a round trip', () => {
  it('comes back exactly as it went in', () => {
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });

  it('never stores the plaintext', () => {
    const ciphertext = encryptSecret(SECRET);
    expect(ciphertext).not.toContain(SECRET);
    expect(ciphertext).not.toContain('0123456789abcdef');
  });

  it('produces a different ciphertext every time the same value is encrypted', () => {
    // A fresh IV per call. Identical ciphertexts would let anyone with read
    // access to the table see which workspaces share a key.
    expect(encryptSecret(SECRET)).not.toBe(encryptSecret(SECRET));
  });

  it('accepts a key written as hex as well as base64', () => {
    process.env.OFFCUT_SECRET_KEY = crypto.randomBytes(32).toString('hex');
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });
});

// ---------------------------------------------------------------------------
describe('The wrong key fails rather than returning garbage', () => {
  it('refuses to decrypt under a different OFFCUT_SECRET_KEY', () => {
    const ciphertext = encryptSecret(SECRET);

    process.env.OFFCUT_SECRET_KEY = KEY_B;

    // The failure is what makes this safe. A cipher without an authentication
    // tag would hand back plausible bytes, and those bytes would be sent to
    // OpenRouter as if the owner had typed them.
    expect(() => decryptSecret(ciphertext)).toThrow(/could not be decrypted/i);
  });

  it('refuses a ciphertext whose bytes were edited in the row', () => {
    const ciphertext = encryptSecret(SECRET);

    const [format, payload] = ciphertext.split('.');
    const bytes = Buffer.from(payload, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = `${format}.${bytes.toString('base64')}`;

    expect(() => decryptSecret(tampered)).toThrow(/could not be decrypted/i);
  });

  it('refuses a ciphertext belonging to another workspace', () => {
    // The workspace id is authenticated alongside the ciphertext, so a row
    // copied between workspaces stops decrypting instead of quietly making one
    // workspace verify its spend against another account.
    const ciphertext = encryptSecret(SECRET, 'workspace-one');

    expect(decryptSecret(ciphertext, 'workspace-one')).toBe(SECRET);
    expect(() => decryptSecret(ciphertext, 'workspace-two')).toThrow(/could not be decrypted/i);
  });

  it('refuses a value that is not in a format it recognises', () => {
    expect(() => decryptSecret('not-a-ciphertext')).toThrow();
    expect(() => decryptSecret('v9.' + Buffer.from('whatever').toString('base64'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('A misconfigured server refuses instead of falling back', () => {
  it('will not encrypt without OFFCUT_SECRET_KEY, and says how to make one', () => {
    delete process.env.OFFCUT_SECRET_KEY;

    expect(secretsConfigured()).toBe(false);
    // The message has to carry the fix. "Missing configuration" sends somebody
    // to the source; a command they can paste does not.
    expect(() => encryptSecret(SECRET)).toThrow(/OFFCUT_SECRET_KEY/);
    expect(() => encryptSecret(SECRET)).toThrow(/randomBytes\(32\)/);
  });

  it('will not accept a key of the wrong length', () => {
    // Base64 of eight bytes. Buffer.from would decode it happily, which is
    // exactly how a short key becomes a weak one without anybody noticing.
    process.env.OFFCUT_SECRET_KEY = crypto.randomBytes(8).toString('base64');

    expect(secretsConfigured()).toBe(false);
    expect(() => requireSecretKey()).toThrow(/32 bytes/);
  });

  it('will not accept a passphrase that merely looks like base64', () => {
    process.env.OFFCUT_SECRET_KEY = 'correcthorsebatterystaple';
    expect(secretsConfigured()).toBe(false);
  });

  it('never puts the configured value into the error', () => {
    const wrong = 'hunter2-this-is-not-a-key';
    process.env.OFFCUT_SECRET_KEY = wrong;

    try {
      requireSecretKey();
      throw new Error('expected a refusal');
    } catch (error) {
      const serialised = JSON.stringify({
        message: (error as Error).message,
        stack: (error as Error).stack,
      });
      expect(serialised).not.toContain(wrong);
    }
  });
});

// ---------------------------------------------------------------------------
describe('The hint identifies a key without being one', () => {
  it('is the last four characters and nothing else', () => {
    expect(secretHint(SECRET)).toBe('cdef');
    expect(SECRET).toContain(secretHint(SECRET));
    expect(secretHint(SECRET).length).toBe(4);
  });

  it('is empty for a value too short to hint at safely', () => {
    expect(secretHint('abc')).toBe('');
    expect(secretHint('')).toBe('');
  });
});
