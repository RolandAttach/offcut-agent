/**
 * One nonce, one attempt.
 *
 * A wallet sign-in is two requests, and the nonce tying them together rides
 * between them in a cookie the API signed. That cookie answers two of the three
 * questions worth asking - is this nonce ours, and is it still young - and it
 * cannot answer the third. Set-Cookie is an instruction to a browser: a client
 * that ignores it hands the same value back as often as it likes, and a request
 * lifted from an access log, a HAR file or a proxy is exactly such a client. A
 * nonce exists so that a fully observed sign-in cannot be spent twice, so the
 * spend has to be something the server holds.
 *
 * It is a row. The unique index decides who was first - the database, not the
 * caller, and not the order two racing replays happen to arrive in. The same
 * trick the store uses for concurrent corrections (invariant 4): there is no
 * window in which one silently wins.
 *
 * Nothing here touches memory, a wallet or a chain. §5 line 151 - "for memory
 * operations no wallet, gas or token purchase is needed" - is untouched by this
 * file: it only makes the optional door shut properly behind whoever came
 * through it.
 */

import { getPrisma } from './db';
import { isUniqueViolation } from './store';
import { sha256 } from './util';

/**
 * Marks a nonce spent, and says whether this call is the one that spent it.
 *
 * Call it BEFORE the signature is checked. A refusal is precisely the moment an
 * attacker would want another go at the same nonce, so the attempt is what
 * costs it - not the success.
 *
 * `expiresAt` is when the cookie carrying the nonce stops verifying. It decides
 * nothing about this spend; it is how long the row has to be kept.
 */
export async function spendSiweNonce(nonce: string, expiresAt: Date): Promise<boolean> {
  const db = getPrisma();

  try {
    await db.spentSiweNonce.create({ data: { nonceHash: sha256(nonce), expiresAt } });
  } catch (error) {
    // The row was already there: a replay, or the loser of two replays racing.
    // Either way this caller did not spend it and gets no attempt.
    if (isUniqueViolation(error)) return false;
    throw error;
  }

  await sweepExpired(db);
  return true;
}

/**
 * Swept on the way past rather than on a timer, because this is the only
 * function that ever writes a row and the table is therefore never bigger than
 * one nonce lifetime of sign-in attempts.
 *
 * A failure here is not allowed to fail a sign-in that has already spent its
 * nonce: the caller would be refused for a reason that has nothing to do with
 * them, and the next attempt sweeps again anyway.
 */
async function sweepExpired(db: ReturnType<typeof getPrisma>): Promise<void> {
  try {
    await db.spentSiweNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch {
    // Deliberately nothing: housekeeping, not the operation the caller asked for.
  }
}
