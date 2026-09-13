/**
 * The wallet door.
 *
 * §5, line 151: "for memory operations no wallet, gas or token purchase is
 * needed", and line 261 lists requiring a wallet on every request as the
 * REJECTED option. So a wallet can only ever be an ADDITIONAL way to reach an
 * account, never a condition of having one — which is why an account here may
 * have an email and no wallet, a wallet and no email, or both, and why none of
 * those three is more real than the others.
 *
 * These tests are about identity, not cryptography. The signature is checked at
 * the HTTP surface, where a keccak implementation already lives; what is proved
 * here is what the core promises once a signature has been checked: one address
 * is one account, however it was written, and whichever door it arrived at.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma, setPrisma, type PrismaClient } from '../db';
import {
  createUser,
  createWorkspace,
  findOrCreateUserByWallet,
  linkWallet,
  listWorkspaces,
  verifyUserCredentials,
} from '../admin';
import { authenticateUser } from '../access';
import { isOffcutError } from '../errors';

const uid = () => Math.random().toString(36).slice(2, 10);

/** A real-looking address, different on every call. */
function anAddress(): string {
  const body = Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  return `0x${body}`;
}

/** The EIP-55 spelling of an address is the same address shouted. */
function shouted(address: string): string {
  return `0x${address.slice(2).toUpperCase()}`;
}

/** Every way a row could reach disk here, including ones this path does not use. */
const WRITES = new Set(['create', 'update', 'upsert']);

/**
 * Runs the same call twice, with each one's first write held until the other
 * has also reached one.
 *
 * Plain Promise.all opened that window on some runs and not others - two to
 * four runs in five, measured here - which is enough to FIND the bug and not
 * enough to guard against it coming back: the two reads and the two writes have
 * to interleave, and nothing in the test decides that they do. This decides it.
 * The hold is released after a quarter second if only one call ever writes, so
 * an implementation that reaches the store some other way fails on what it did
 * rather than by timing out.
 */
async function twiceAtOnce<T>(call: () => Promise<T>): Promise<[T, T]> {
  const real = getPrisma();
  const users = real.user as unknown as Record<string, unknown>;

  let arrived = 0;
  let open!: () => void;
  const both = new Promise<void>((resolve) => {
    open = resolve;
  });

  const held = new Proxy(users, {
    get(delegate, method) {
      const value = Reflect.get(delegate, method);
      if (typeof value !== 'function' || !WRITES.has(String(method))) return value;

      return async (...args: unknown[]) => {
        arrived += 1;
        if (arrived >= 2) open();
        await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 250))]);
        return (value as (...a: unknown[]) => Promise<unknown>).apply(delegate, args);
      };
    },
  });

  setPrisma(
    new Proxy(real, {
      get: (client, property, receiver) =>
        property === 'user' ? held : Reflect.get(client, property, receiver),
    }) as unknown as PrismaClient
  );

  try {
    return await Promise.all([call(), call()]);
  } finally {
    setPrisma(real);
  }
}

describe('One address is one account', () => {
  it('opens an account the first time an address signs in, and finds it ever after', async () => {
    const address = anAddress();

    const first = await findOrCreateUserByWallet(address);
    const second = await findOrCreateUserByWallet(address);

    expect(second.id).toBe(first.id);
    expect(await getPrisma().user.count({ where: { walletAddress: address } })).toBe(1);
  });

  it('opens one account, not two, when a new address signs in from two tabs at once', async () => {
    const address = anAddress();

    // Nothing adversarial about this: the login page asks for a signature as
    // soon as a connected wallet is on the right chain, so a restored tab
    // beside a fresh one sends both halves of a first sign-in at once.
    const [firstTab, secondTab] = await twiceAtOnce(() => findOrCreateUserByWallet(address));

    expect(secondTab.id).toBe(firstTab.id);
    expect(await getPrisma().user.count({ where: { walletAddress: address } })).toBe(1);
  });

  it('keeps what the second tab made reachable, because the second tab is the same account', async () => {
    const address = anAddress();
    const [firstTab, secondTab] = await twiceAtOnce(() => findOrCreateUserByWallet(address));

    const made = await createWorkspace({ ownerId: secondTab.id, name: 'Made in the second tab' });

    // Signing again is the whole credential a wallet account has. If it landed
    // anywhere else, this workspace, its agent keys and every record in it
    // would still be in the store with nothing left that could reach them.
    const later = await findOrCreateUserByWallet(address);
    const theirs = await listWorkspaces(later.id);

    expect(later.id).toBe(firstTab.id);
    expect(theirs.map((workspace) => workspace.id)).toContain(made.id);
  });

  it('reaches the hand-linked account even when two sign-ins race for the same address', async () => {
    const owner = await createUser({
      email: `owner-${uid()}@offcut.test`,
      password: 'correct-horse-battery',
      displayName: 'Typed It In',
    });
    const address = anAddress();
    await linkWallet(owner.id, address);

    const [one, two] = await Promise.all([
      findOrCreateUserByWallet(address),
      findOrCreateUserByWallet(address),
    ]);

    expect(one.id).toBe(owner.id);
    expect(two.id).toBe(owner.id);
    expect(await getPrisma().user.count()).toBe(1);
  });

  it('reaches one fixed account when two accounts of the same age name the same address', async () => {
    const address = anAddress();
    const first = await createUser({
      email: `first-${uid()}@offcut.test`,
      password: 'correct-horse-battery',
      displayName: 'First',
    });
    const second = await createUser({
      email: `second-${uid()}@offcut.test`,
      password: 'correct-horse-battery',
      displayName: 'Second',
    });
    // A payout address is a preference, not a proof: two people may name the
    // same one, and both rows may be written inside one millisecond. Age alone
    // cannot tell them apart, which is exactly when "the oldest" used to mean
    // whichever row came back first.
    await linkWallet(first.id, address);
    await linkWallet(second.id, address);
    await getPrisma().user.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { createdAt: new Date('2026-09-15T21:34:04.623Z') },
    });

    const signedIn = await findOrCreateUserByWallet(address);
    const again = await findOrCreateUserByWallet(address);

    expect(signedIn.id).toBe([first.id, second.id].sort()[0]);
    expect(again.id).toBe(signedIn.id);
  });

  it('finds the same account when the address arrives in a different casing', async () => {
    const address = anAddress();
    const opened = await findOrCreateUserByWallet(shouted(address));

    // A wallet that checksums its address and one that does not are the same
    // wallet; a second account here would split one person's memory in two.
    const again = await findOrCreateUserByWallet(address);

    expect(again.id).toBe(opened.id);
    expect(again.wallet.address).toBe(address);
    expect(await getPrisma().user.count()).toBe(1);
  });

  it('names a wallet-only account after its address and gives it no email or password', async () => {
    const address = anAddress();
    const user = await findOrCreateUserByWallet(address);

    expect(user.email).toBeNull();
    expect(user.displayName).toBe(`${address.slice(0, 6)}…${address.slice(-4)}`);

    const row = await getPrisma().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toBeNull();
    expect(row.email).toBeNull();
  });

  it('signs into the account that linked this address by hand, rather than opening a second one', async () => {
    const email = `owner-${uid()}@offcut.test`;
    const typed = await createUser({ email, password: 'correct-horse-battery', displayName: 'Typed It In' });
    const address = anAddress();
    await linkWallet(typed.id, address);

    const signedIn = await findOrCreateUserByWallet(shouted(address));

    expect(signedIn.id).toBe(typed.id);
    expect(signedIn.email).toBe(email);
    expect(signedIn.displayName).toBe('Typed It In');
    expect(await getPrisma().user.count()).toBe(1);
  });

  it('records that a signature proved an address a hand link only claimed', async () => {
    const owner = await createUser({
      email: `owner-${uid()}@offcut.test`,
      password: 'correct-horse-battery',
      displayName: 'Typed It In',
    });
    const address = anAddress();
    await linkWallet(owner.id, address);

    const claimed = await getPrisma().user.findUniqueOrThrow({ where: { id: owner.id } });
    // PUT /auth/wallet says in as many words that nothing was signed.
    expect(claimed.walletProvenAt).toBeNull();
    expect(claimed.walletLinkedAt).not.toBeNull();

    await findOrCreateUserByWallet(address);

    const proven = await getPrisma().user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(proven.walletProvenAt).not.toBeNull();
    // The day it was linked is not rewritten by the day it was proved.
    expect(proven.walletLinkedAt?.toISOString()).toBe(claimed.walletLinkedAt?.toISOString());
  });

  it('refuses the zero address, which nobody holds the key to', async () => {
    await expect(
      findOrCreateUserByWallet('0x0000000000000000000000000000000000000000')
    ).rejects.toThrow(/zero address/i);
  });
});

describe('A wallet account has no password to guess', () => {
  it('refuses a password login with the same sentence a wrong password gets', async () => {
    const email = `owner-${uid()}@offcut.test`;
    await createUser({ email, password: 'correct-horse-battery', displayName: 'Has A Password' });

    const walletOnly = await findOrCreateUserByWallet(anAddress());
    // The address is the only handle this account has, so that is what an
    // attacker would type into the email field.
    const noEmailToTry = `${walletOnly.wallet.address}@offcut.test`;

    const wrongPassword = await verifyUserCredentials(email, 'not-the-password').catch((e) => e);
    const walletAccount = await verifyUserCredentials(noEmailToTry, 'anything at all').catch((e) => e);

    expect(isOffcutError(wrongPassword)).toBe(true);
    expect(isOffcutError(walletAccount)).toBe(true);
    // Whether an address has an email beside it is not public information.
    expect(walletAccount.message).toBe(wrongPassword.message);
    expect(walletAccount.code).toBe(wrongPassword.code);
  });

  it('refuses an empty password against an account whose passwordHash is null', async () => {
    // Reaching the account by email is the only way to get a null hash as far
    // as verifyPassword, so the row is given one for the length of this test.
    const wallet = await findOrCreateUserByWallet(anAddress());
    const email = `late-${uid()}@offcut.test`;
    await getPrisma().user.update({ where: { id: wallet.id }, data: { email } });

    for (const attempt of ['', 'anything', 'scrypt$$']) {
      await expect(verifyUserCredentials(email, attempt)).rejects.toThrow(
        'Incorrect email or password.'
      );
    }
  });
});

describe('Nothing that leaves this module carries a secret', () => {
  it('returns no passwordHash from the wallet door', async () => {
    const user = await findOrCreateUserByWallet(anAddress());
    expect(JSON.stringify(user)).not.toContain('passwordHash');
    expect(Object.keys(user)).toEqual(['id', 'email', 'displayName', 'wallet']);
  });

  it('resolves a wallet-only session into a principal with a null email', async () => {
    const wallet = await findOrCreateUserByWallet(anAddress());
    const principal = await authenticateUser(wallet.id);

    expect(principal.kind).toBe('user');
    if (principal.kind !== 'user') throw new Error('unreachable');
    expect(principal.email).toBeNull();
    expect(principal.displayName).toBe(wallet.displayName);
    expect(JSON.stringify(principal)).not.toContain('passwordHash');
  });
});
