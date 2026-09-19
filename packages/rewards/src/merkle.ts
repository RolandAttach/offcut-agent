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
 * This is a deliberate second implementation of packages/contracts/test/merkle.ts.
 * That file is private tooling for the contract suite and is not a dependency
 * of anything that ships; importing it here would make the publisher job depend
 * on a Hardhat test fixture. The cost of copying it is that the two can drift,
 * so merkle.test.ts builds the same input with both and requires the same root
 * — the contract suite pins that file against the deployed verifier, so
 * agreeing with it is agreeing with the chain.
 */

import { AbiCoder, concat, keccak256 } from 'ethers';

export interface RewardEntry {
  /** 0x address. Case is irrelevant to the leaf; the tree keys on lowercase. */
  account: string;
  /** The total this account has EVER earned, in base units. Roots are cumulative. */
  cumulativeAmount: bigint;
}

export interface RewardTree {
  root: string;
  /** The entries in the order they were hashed. */
  entries: RewardEntry[];
  /** Proof per lowercase address. */
  proofs: Record<string, string[]>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function leafOf(entry: RewardEntry): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [entry.account, entry.cumulativeAmount]
  );
  return keccak256(keccak256(encoded));
}

function hashPair(a: string, b: string): string {
  const [left, right] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([left, right]));
}

/**
 * Root and proofs for a set of cumulative balances.
 *
 * Entries are sorted by address first. The root must be a function of the SET
 * and nothing else: without this it would depend on the order rows came back
 * from the database, two runs over identical data would publish different
 * roots, and nobody comparing them could tell a reordering from a change.
 */
export function buildTree(entries: RewardEntry[]): RewardTree {
  if (entries.length === 0) throw new Error('A tree with no entries has no root to publish.');

  const seen = new Set<string>();
  for (const entry of entries) {
    if (!ADDRESS.test(entry.account)) {
      throw new Error(`Not an address: ${entry.account}`);
    }
    const key = entry.account.toLowerCase();
    // Two leaves for one address would let the holder of the larger one be
    // undercut by a proof for the smaller — and more importantly means the
    // accounting that produced this list is wrong.
    if (seen.has(key)) throw new Error(`Duplicate account in tree: ${entry.account}`);
    seen.add(key);

    if (entry.cumulativeAmount < 0n) {
      throw new Error(`Negative cumulative amount for ${entry.account}; a root cannot take money back.`);
    }
    // Not merely useless: a zero leaf is one more chance for the accounting
    // upstream to be wrong in a way the tree would happily certify.
    if (entry.cumulativeAmount === 0n) {
      throw new Error(`${entry.account} is owed nothing and does not belong in the tree.`);
    }
  }

  const sorted = [...entries].sort((a, b) => {
    const left = a.account.toLowerCase();
    const right = b.account.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });

  /** Every level, leaves first. */
  const levels: string[][] = [];
  let level = sorted.map(leafOf);
  levels.push(level);

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      // An odd node is carried up unchanged rather than paired with itself,
      // matching the standard construction the verifier expects.
      next.push(
        index + 1 < level.length ? hashPair(level[index]!, level[index + 1]!) : level[index]!
      );
    }
    levels.push(next);
    level = next;
  }

  const proofs: Record<string, string[]> = {};
  for (let position = 0; position < sorted.length; position += 1) {
    const proof: string[] = [];
    let index = position;
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      const nodes = levels[depth]!;
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < nodes.length) proof.push(nodes[sibling]!);
      index = Math.floor(index / 2);
    }
    proofs[sorted[position]!.account.toLowerCase()] = proof;
  }

  return { root: levels[levels.length - 1]![0]!, entries: sorted, proofs };
}
