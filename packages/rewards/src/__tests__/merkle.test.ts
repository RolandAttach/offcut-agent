/**
 * The tree, and the one thing that matters about it: the contract agrees.
 *
 * merkle.ts is a deliberate second implementation of the builder the contract
 * suite uses, because that file is Hardhat test tooling and nothing that ships
 * may depend on it. A second implementation can drift, and a Merkle builder
 * that has drifted looks completely healthy - it produces a root, it produces
 * proofs, and every one of them is rejected on-chain.
 *
 * So the agreement is pinned here: the same entries through both builders must
 * give the same root and the same proofs. The contract suite pins ITS builder
 * against the deployed verifier, so this is, transitively, agreement with the
 * chain.
 */

import { describe, expect, it } from 'vitest';
// Resolved through the `hardhat` -> `ethers` alias in vitest.config.ts; that
// file explains why the swap is sound.
import { MerkleTree, type Entry } from '../../../contracts/test/merkle';
import { buildTree, leafOf } from '../merkle';
import { ONE_TOKEN } from '../config';

function account(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

/** Sorted, because our builder sorts and the contract suite's trusts its caller. */
function entries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    account: account(index + 1),
    cumulativeAmount: BigInt(index + 1) * ONE_TOKEN + BigInt(index),
  }));
}

// ---------------------------------------------------------------------------
describe('Agreement with the contract suite', () => {
  // Odd counts matter: a level with an odd node carries it up unpaired, and a
  // builder that pairs it with itself instead disagrees only from three
  // entries upward.
  for (const count of [1, 2, 3, 4, 5, 7, 16, 17]) {
    it(`produces the same root as the contract builder for ${count} entries`, () => {
      const input = entries(count);

      expect(buildTree(input).root).toBe(new MerkleTree(input).root);
    });
  }

  it('produces the same proofs, not merely the same root', () => {
    const input = entries(7);
    const ours = buildTree(input);
    const theirs = new MerkleTree(input);

    for (const entry of input) {
      expect(ours.proofs[entry.account.toLowerCase()]).toEqual(theirs.proofFor(entry.account));
    }
  });

  it('hashes a leaf the same way', () => {
    const entry = { account: account(9), cumulativeAmount: 123_456_789n };

    expect(leafOf(entry)).toBe(new MerkleTree([entry]).root);
  });
});

// ---------------------------------------------------------------------------
describe('A root that identifies a set of balances', () => {
  it('does not depend on the order the rows arrived in', () => {
    // Two runs over the same ledger must publish the same root, or nobody
    // comparing two roots can tell a reordering from a change.
    const input = entries(6);
    const shuffled = [input[3]!, input[0]!, input[5]!, input[2]!, input[4]!, input[1]!];

    expect(buildTree(shuffled).root).toBe(buildTree(input).root);
  });

  it('changes when a single base unit changes', () => {
    const input = entries(5);
    const nudged = input.map((entry, index) =>
      index === 2 ? { ...entry, cumulativeAmount: entry.cumulativeAmount + 1n } : entry
    );

    expect(buildTree(nudged).root).not.toBe(buildTree(input).root);
  });
});

// ---------------------------------------------------------------------------
describe('Entries the tree will not take', () => {
  it('refuses two leaves for one address', () => {
    // The smaller leaf would be a valid proof that undercuts the larger, and
    // the list that produced it is wrong either way.
    expect(() =>
      buildTree([
        { account: account(1), cumulativeAmount: ONE_TOKEN },
        { account: account(1), cumulativeAmount: 2n * ONE_TOKEN },
      ])
    ).toThrow(/Duplicate account/);
  });

  it('refuses an entry owed nothing', () => {
    expect(() => buildTree([{ account: account(1), cumulativeAmount: 0n }])).toThrow(
      /owed nothing/
    );
  });

  it('refuses a negative balance', () => {
    expect(() => buildTree([{ account: account(1), cumulativeAmount: -1n }])).toThrow(
      /cannot take money back/
    );
  });

  it('refuses something that is not an address', () => {
    expect(() => buildTree([{ account: 'alice', cumulativeAmount: ONE_TOKEN }])).toThrow(
      /Not an address/
    );
  });

  it('refuses to publish an empty tree', () => {
    expect(() => buildTree([])).toThrow(/no root to publish/);
  });
});
