/**
 * The spend behind the wallet door.
 *
 * A nonce is one promise: that having watched a sign-in is not enough to
 * perform another. The cookie carrying it cannot keep that promise on its own —
 * it is handed to the client, and a client may hand it back as often as it
 * likes — so the promise is kept here, by a row. These tests are about the row:
 * what it refuses, what settles a tie, and what it stops holding.
 *
 * Nothing here is about cryptography or about wallets. The signature is checked
 * at the HTTP surface, and §5 line 151 still holds either way: an account that
 * never touches a wallet never reaches this file at all.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma } from '../db';
import { spendSiweNonce } from '../siwe-nonces';
import { sha256 } from '../util';

const aNonce = () => `nonce-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** As long as the cookie carrying it verifies, which is all the row must outlive. */
const whileTheCookieLives = () => new Date(Date.now() + 5 * 60_000);

describe('One nonce, one attempt', () => {
  it('spends a nonce the first time it is presented', async () => {
    expect(await spendSiweNonce(aNonce(), whileTheCookieLives())).toBe(true);
  });

  it('refuses every later presentation of the same nonce', async () => {
    const nonce = aNonce();

    expect(await spendSiweNonce(nonce, whileTheCookieLives())).toBe(true);

    // Not "the second one": a captured request is replayed until it stops
    // working, so what has to be true is that it never starts working again.
    expect(await spendSiweNonce(nonce, whileTheCookieLives())).toBe(false);
    expect(await spendSiweNonce(nonce, whileTheCookieLives())).toBe(false);
    expect(await spendSiweNonce(nonce, whileTheCookieLives())).toBe(false);
  });

  it('gives the nonce to exactly one of two presentations arriving together', async () => {
    const nonce = aNonce();

    // Two copies of one captured request, racing. A check followed by a write
    // would let both through the gap between them; the unique index has no gap.
    const spends = await Promise.all([
      spendSiweNonce(nonce, whileTheCookieLives()),
      spendSiweNonce(nonce, whileTheCookieLives()),
    ]);

    expect(spends.filter(Boolean)).toHaveLength(1);
    expect(await getPrisma().spentSiweNonce.count({ where: { nonceHash: sha256(nonce) } })).toBe(1);
  });

  it('remembers a hash, so a spent nonce is not a secret this store keeps', async () => {
    const nonce = aNonce();
    await spendSiweNonce(nonce, whileTheCookieLives());

    const rows = await getPrisma().spentSiweNonce.findMany();
    expect(rows.map((row) => row.nonceHash)).toContain(sha256(nonce));
    // The nonce itself is nowhere in the row, and a hash is not a nonce.
    expect(JSON.stringify(rows)).not.toContain(nonce);
  });

  it('forgets a nonce once no cookie could still be carrying it', async () => {
    const stale = sha256(aNonce());
    await getPrisma().spentSiweNonce.create({
      data: { nonceHash: stale, expiresAt: new Date(Date.now() - 1_000) },
    });

    // The next spend sweeps: the cookie for that nonce stopped verifying, so
    // the row has nothing left to refuse and the table stays the size of one
    // nonce lifetime rather than growing forever.
    await spendSiweNonce(aNonce(), whileTheCookieLives());

    expect(await getPrisma().spentSiweNonce.count({ where: { nonceHash: stale } })).toBe(0);
  });
});
