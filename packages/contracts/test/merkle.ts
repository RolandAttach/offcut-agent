import { ethers } from 'hardhat';

/**
 * The Merkle tree the distributor verifies against.
 *
 * Two details decide whether a proof built here is accepted on-chain, and
 * getting either wrong produces a tree that looks fine and verifies nothing:
 *
 *   - **Leaves are hashed twice.** keccak256(keccak256(abi.encode(...))). The
 *     second hash is what stops a 64-byte leaf from being reinterpreted as an
 *     internal node, which is how a forged proof for an amount nobody earned
 *     would otherwise be constructed.
 *   - **Pairs are sorted before hashing.** OpenZeppelin's verifier sorts, so a
 *     builder that does not will disagree with it for any tree wider than one.
 *
 * This is the same shape the publisher job uses; the contract tests pin the
 * agreement so the two cannot drift apart unnoticed.
 */

export interface Entry {
  account: string;
  cumulativeAmount: bigint;
}

export function leafOf(entry: Entry): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [entry.account, entry.cumulativeAmount]
  );
  return ethers.keccak256(ethers.keccak256(encoded));
}

function hashPair(a: string, b: string): string {
  const [left, right] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

export class MerkleTree {
  /** Every level, leaves first. */
  private readonly levels: string[][] = [];

  constructor(public readonly entries: Entry[]) {
    if (entries.length === 0) throw new Error('A tree with no entries has no root to publish.');

    const seen = new Set<string>();
    for (const entry of entries) {
      const key = entry.account.toLowerCase();
      // Two leaves for one address would let the holder of the larger one be
      // undercut by a proof for the smaller — and more importantly means the
      // accounting that produced this list is wrong.
      if (seen.has(key)) throw new Error(`Duplicate account in tree: ${entry.account}`);
      seen.add(key);
    }

    let level = entries.map(leafOf);
    this.levels.push(level);

    while (level.length > 1) {
      const next: string[] = [];
      for (let index = 0; index < level.length; index += 2) {
        // An odd node is carried up unchanged rather than paired with itself,
        // matching the standard construction the verifier expects.
        next.push(index + 1 < level.length ? hashPair(level[index]!, level[index + 1]!) : level[index]!);
      }
      this.levels.push(next);
      level = next;
    }
  }

  get root(): string {
    return this.levels[this.levels.length - 1]![0]!;
  }

  proofFor(account: string): string[] {
    const target = account.toLowerCase();
    let index = this.entries.findIndex((entry) => entry.account.toLowerCase() === target);
    if (index === -1) throw new Error(`No entry for ${account}`);

    const proof: string[] = [];
    for (let depth = 0; depth < this.levels.length - 1; depth += 1) {
      const level = this.levels[depth]!;
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < level.length) proof.push(level[sibling]!);
      index = Math.floor(index / 2);
    }
    return proof;
  }
}
