/**
 * Encryption for the few secrets that must be stored rather than hashed.
 *
 * Almost nothing secret in this system is recoverable: an agent key is compared
 * by hash (util.ts), a password by hash (admin.ts), and neither can be read back
 * even by us. The workspace's OpenRouter key is the exception. Confirming what a
 * generation actually cost means presenting that key to OpenRouter, so it has to
 * come back out again — which is the only reason this file exists, and should
 * stay the only reason.
 *
 * AES-256-GCM rather than CBC because the ciphertext lives in a database row an
 * operator can edit. Without the authentication tag, a flipped byte decrypts to
 * a DIFFERENT key rather than failing, and that key would then be presented to
 * OpenRouter as if the owner had typed it.
 *
 * There is no fallback. No default key, no plaintext column, no "encrypt only if
 * configured". A missing OFFCUT_SECRET_KEY makes the operation fail with the
 * command that fixes it, because the alternative — a deployment that quietly
 * stores customer API keys in plaintext — is the kind of failure nobody notices
 * until it is a disclosure.
 *
 * Nothing here ever puts a key, or a fragment of one, into an error message.
 */

import crypto from 'node:crypto';
import './env';

const ENV_VAR = 'OFFCUT_SECRET_KEY';

const KEY_BYTES = 32;
/** 96 bits: the nonce size GCM is specified and fastest for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Stamped into every ciphertext so a future change of algorithm can be told
 * apart from corruption, instead of being decrypted as garbage.
 */
const FORMAT = 'v1';

/** Enough to say WHICH key is linked, useless as a key. */
const HINT_CHARS = 4;

const HOW_TO_GENERATE =
  `${ENV_VAR} is not set, so credentials cannot be encrypted and nothing will be stored.\n\n` +
  'Generate one and put it in .env:\n\n' +
  '  node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"\n\n' +
  'Keep it out of version control, and keep a copy: every credential encrypted with it ' +
  'becomes unreadable if it is lost, and each workspace owner has to link their key again.';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX = /^[0-9a-fA-F]{64}$/;

// Re-derived whenever the variable changes rather than captured at import, so a
// process that loads .env late — and a test that sets a different key — both get
// the key that is actually configured now.
let cached: { raw: string; key: Buffer } | null = null;

/**
 * The configured key, or an explanation of how to make one.
 *
 * Accepts hex or base64 because both are what people have to hand: `openssl
 * rand -hex 32` and node's randomBytes().toString('base64') are the two ways
 * this gets generated in practice, and rejecting either is a support ticket.
 */
export function requireSecretKey(): Buffer {
  const raw = (process.env[ENV_VAR] ?? '').trim();
  if (!raw) throw new Error(HOW_TO_GENERATE);

  if (cached && cached.raw === raw) return cached.key;

  const key = parseKey(raw);
  if (!key) {
    // The length is named; the value is not. An error message is the one place
    // a secret is most likely to end up copied into a bug report.
    throw new Error(
      `${ENV_VAR} must be exactly ${KEY_BYTES} bytes, written as ${KEY_BYTES * 2} hex characters ` +
        `or as base64. The configured value is neither.\n\n${HOW_TO_GENERATE}`
    );
  }

  cached = { raw, key };
  return key;
}

function parseKey(raw: string): Buffer | null {
  if (HEX.test(raw)) return Buffer.from(raw, 'hex');

  // Buffer.from(..., 'base64') silently drops characters it does not recognise,
  // so "hunter2" parses to four bytes instead of failing. The shape is checked
  // first and the length after, because a short key is a weak key.
  if (!BASE64.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === KEY_BYTES ? decoded : null;
}

/** Whether a credential could be stored right now. Never reveals the key. */
export function secretsConfigured(): boolean {
  try {
    requireSecretKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts one short secret.
 *
 * `aad` is authenticated but not encrypted: pass the id of the row this
 * ciphertext belongs to and a value lifted out of one workspace's row and
 * pasted into another's stops decrypting, instead of quietly making a second
 * workspace verify its spend against someone else's account.
 *
 * A fresh random IV per call is what makes GCM safe to reuse with one key. It
 * is stored beside the ciphertext because it is not secret — only unique.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const key = requireSecretKey();
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${FORMAT}.${Buffer.concat([iv, tag, body]).toString('base64')}`;
}

/**
 * Decrypts one short secret, or throws.
 *
 * Throwing covers every way this can go wrong — the wrong OFFCUT_SECRET_KEY, an
 * edited row, a different `aad` — and they are deliberately indistinguishable to
 * the caller. Every one of them means the same thing operationally: this value
 * cannot be used, and nothing may proceed as if it could.
 */
export function decryptSecret(payload: string, aad?: string): string {
  const key = requireSecretKey();

  const separator = payload.indexOf('.');
  const format = separator === -1 ? '' : payload.slice(0, separator);
  if (format !== FORMAT) {
    throw new Error('This stored credential is not in a format this version can read.');
  }

  const raw = Buffer.from(payload.slice(separator + 1), 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('This stored credential could not be decrypted.');
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    // final() is where GCM verifies the tag: without it a wrong key returns
    // plausible-looking bytes and this function would hand back garbage.
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // The underlying error is swallowed on purpose. Node's message for a failed
    // tag check is fine, but anything thrown from here travels towards a log,
    // and this is not a path where a stack trace should carry buffers around.
    throw new Error('This stored credential could not be decrypted.');
  }
}

/**
 * The last few characters of a secret, for showing which one is linked.
 *
 * Shown by the console beside "linked" so an owner can tell the key they just
 * rotated from the one still stored. Four characters of an OpenRouter key are
 * not enough to be one, and the rest is never returned by anything.
 */
export function secretHint(value: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length <= HINT_CHARS ? '' : trimmed.slice(-HINT_CHARS);
}
