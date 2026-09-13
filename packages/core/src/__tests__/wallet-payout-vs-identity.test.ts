/**
 * Two addresses that look like one.
 *
 * An account has a payout address (typed, changeable, proves nothing) and a
 * sign-in address (proved by a signature, unique, how the account is reached).
 * For an email account the difference is cosmetic. For a wallet-only account it
 * is the difference between having an account and not: it has no email, so the
 * sign-in address is its only door.
 *
 * Found after the fact: changing where to be paid used to clear the sign-in
 * address too, and the next signature from the same key opened a fresh, empty
 * account beside the one holding the workspaces. No concurrency, no attacker —
 * one owner, one console, one honest change of payout address.
 */

import { describe, expect, it } from 'vitest';
import {
  findOrCreateUserByWallet,
  getLinkedWallet,
  linkWallet,
  unlinkWallet,
} from '../admin';
import { getPrisma } from '../db';

let counter = 0;
function freshAddress(): string {
  counter += 1;
  return `0x${(0xa11ce000000000n + BigInt(counter)).toString(16).padStart(40, '0')}`;
}

describe('Where you are paid is not who you are', () => {
  it('still opens to its own key after the payout address is pointed elsewhere', async () => {
    const key = freshAddress();
    const elsewhere = freshAddress();

    const opened = await findOrCreateUserByWallet(key);
    await linkWallet(opened.id, elsewhere);

    const again = await findOrCreateUserByWallet(key);
    expect(again.id).toBe(opened.id);

    // One account for this key, not two.
    const rows = await getPrisma().user.findMany({ where: { walletProvenAddress: key } });
    expect(rows).toHaveLength(1);
  });

  it('still opens to its own key after the payout address is forgotten', async () => {
    const key = freshAddress();

    const opened = await findOrCreateUserByWallet(key);
    await unlinkWallet(opened.id);

    const again = await findOrCreateUserByWallet(key);
    expect(again.id).toBe(opened.id);
  });

  it('stops calling the payout address proven the moment it differs from the key', async () => {
    // The claim the console makes — "this wallet signed in" — is about the
    // payout address. Keeping the sign-in address must not keep that claim.
    const key = freshAddress();
    const elsewhere = freshAddress();

    const opened = await findOrCreateUserByWallet(key);
    expect((await getLinkedWallet(opened.id)).provenAt).not.toBeNull();

    await linkWallet(opened.id, elsewhere);
    const typed = await getLinkedWallet(opened.id);
    expect(typed.address).toBe(elsewhere);
    expect(typed.provenAt).toBeNull();

    // Pointing it back at the key restores the claim without a new signature:
    // the proof was of the key, and the key has not changed.
    await linkWallet(opened.id, key);
    expect((await getLinkedWallet(opened.id)).provenAt).not.toBeNull();
  });

  it('never lets typing an address write the sign-in column', async () => {
    // A unique column that typing could fill would answer "already taken" to
    // anyone typing a stranger's address. Only a signature writes it.
    const key = freshAddress();
    const stranger = freshAddress();

    const owner = await findOrCreateUserByWallet(key);
    const other = await findOrCreateUserByWallet(freshAddress());

    await linkWallet(other.id, key); // naming the owner's address by hand
    await linkWallet(owner.id, stranger); // and the owner naming somebody else's

    const ownerRow = await getPrisma().user.findUnique({ where: { id: owner.id } });
    const otherRow = await getPrisma().user.findUnique({ where: { id: other.id } });
    expect(ownerRow?.walletProvenAddress).toBe(key);
    expect(otherRow?.walletProvenAddress).not.toBe(key);
  });
});
