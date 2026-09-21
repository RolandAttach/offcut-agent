/**
 * When a root is worth a transaction, and when it is not.
 *
 * Measured gas is 0.0000036 ETH per publish and there are 144 of them in a day,
 * so a service that publishes unconditionally costs roughly forty-six dollars a
 * month to say nothing. Most ten-minute windows on this product contain no
 * retrievals at all. The skip is not an optimisation; it is the difference
 * between the running cost and almost none of it.
 *
 * The other half of this file is about what happens when a transaction does not
 * land - which, because roots are cumulative, should cost nothing but a delay.
 */

import { AbiCoder, concat, keccak256 } from 'ethers';
import { describe, expect, it } from 'vitest';
import { RECHECK_CHAIN_MS } from '../service';
import { ALICE, BOB, NO_ROOT, PERIOD_0, atPeriod, fakeChain, harness } from './fakes';

/**
 * OpenZeppelin's verifier, and the leaf the contract hashes in `claim`, written
 * out here rather than imported.
 *
 * The point of the test below is that a file this service wrote is claimable,
 * and reusing the builder's own helpers to check the builder would prove only
 * that it agrees with itself. This is the Solidity, transcribed: leaves hashed
 * twice, pairs sorted before hashing.
 */
function leafFor(address: string, amount: bigint): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, amount]);
  return keccak256(keccak256(encoded));
}

function verifies(proof: string[], root: string, leaf: string): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed =
      BigInt(computed) < BigInt(sibling)
        ? keccak256(concat([computed, sibling]))
        : keccak256(concat([sibling, computed]));
  }
  return computed === root;
}

describe('Deciding whether to send a transaction', () => {
  it('sends nothing when nobody earned anything in the window', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });

    const report = await world.run();

    expect(report.publish.kind).toBe('nothing-earned');
    expect(world.chain.attempted).toEqual([]);
  });

  it('sends nothing for a quiet period, because the root has not moved', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);

    await world.run();
    expect(world.chain.published).toHaveLength(1);

    // Four quiet periods. Nobody earns, the cumulative totals do not change, so
    // the root does not change and the chain is not asked to restate it.
    for (const offset of [2, 3, 4, 5]) {
      world.setNow(atPeriod(PERIOD_0 + offset, 20_000));
      const report = await world.run();
      expect(report.publish.kind).toBe('unchanged');
    }

    expect(world.chain.attempted).toHaveLength(1);
  });

  it('sends one transaction when somebody does earn', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    world.rewards.earn(PERIOD_0 + 1, BOB, 2);
    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    const report = await world.run();

    expect(report.publish.kind).toBe('published');
    expect(world.chain.published).toHaveLength(2);
    expect(world.chain.published[1]).not.toBe(world.chain.published[0]);
  });

  it('does not publish into a paused contract', async () => {
    // publishRoot is whenNotPaused, so this would revert every ten minutes and
    // cost gas each time to learn something one call can answer for free.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    world.chain.setPaused(true);

    const report = await world.run();

    expect(report.publish.kind).toBe('paused');
    expect(world.chain.attempted).toEqual([]);
  });
});

describe('When a transaction does not land', () => {
  it('waits for the next period instead of retrying immediately', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    world.chain.failNext('replacement fee too low');

    const first = await world.run();

    expect(first.publish).toMatchObject({ kind: 'failed' });
    expect(world.chain.attempted).toHaveLength(1);
    expect(world.chain.published).toEqual([]);
    // Nothing was written for a root that is not on chain; the console must
    // never hand out a proof against a root nobody can verify against.
    expect(world.proofs.documents).toEqual([]);
  });

  it('heals on the next period, because the root is cumulative', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    world.chain.failNext('replacement fee too low');
    await world.run();

    world.rewards.earn(PERIOD_0 + 1, BOB, 1);
    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    const second = await world.run();

    expect(second.publish.kind).toBe('published');
    // One transaction covers both periods: the root that lands carries what the
    // failed one would have said and what has happened since.
    expect(world.chain.published).toHaveLength(1);

    const latest = world.proofs.documents[world.proofs.documents.length - 1]!;
    expect(Object.keys(latest.claims).sort()).toEqual([ALICE, BOB].sort());
  });

  it('keeps settling periods even while publishing keeps failing', async () => {
    // Accrual and publication are separate on purpose: a chain that is refusing
    // us is not a reason to stop recording what people earned.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });

    for (const offset of [0, 1, 2]) {
      world.rewards.earn(PERIOD_0 + offset, ALICE, 1);
      world.chain.failNext('nonce too low');
      world.setNow(atPeriod(PERIOD_0 + offset + 1, 20_000));
      await world.run();
    }

    expect(world.chain.published).toEqual([]);
    expect(world.rewards.written).toEqual([PERIOD_0, PERIOD_0 + 1, PERIOD_0 + 2]);
  });
});

describe('Quiet hours cost nothing, not even a read', () => {
  it('does not ask the chain again while the root has not moved', async () => {
    // Two reads every ten minutes, for an answer that cannot have changed,
    // is what the public endpoint was refusing: on 2026-09-22 it answered 429
    // to about half of all ticks, and each refusal failed the whole tick. The
    // root a publication put there is known, so a tick with nothing new to say
    // says nothing and asks nothing.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    const afterPublishing = world.chain.reads();

    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    await world.run();
    world.setNow(atPeriod(PERIOD_0 + 3, 20_000));
    const report = await world.run();

    expect(report.publish.kind).toBe('unchanged');
    expect(world.chain.reads()).toBe(afterPublishing);
  });

  it('reads the chain again once the remembered root is old enough to doubt', async () => {
    // Remembering is a saving, not a source of truth: a chain that moved
    // without us - another publisher key, a manual root - must be noticed.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    const afterPublishing = world.chain.reads();

    world.setNow(atPeriod(PERIOD_0 + 1, 20_000) + RECHECK_CHAIN_MS + 1);
    await world.run();

    expect(world.chain.reads()).toBeGreaterThan(afterPublishing);
  });

  it('still asks the chain when the root has moved', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    const afterPublishing = world.chain.reads();

    world.rewards.earn(PERIOD_0 + 1, BOB, 4);
    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    const report = await world.run();

    expect(report.publish.kind).toBe('published');
    expect(world.chain.reads()).toBeGreaterThan(afterPublishing);
  });
});

describe('The proof files', () => {
  it('writes a proof that verifies against the root that was published', async () => {
    // The whole point of the file. If this fails, every claim fails.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 3);
    world.rewards.earn(PERIOD_0, BOB, 7);
    await world.run();

    const document = world.proofs.documents[0]!;
    expect(document.root).toBe(world.chain.published[0]);

    for (const claim of Object.values(document.claims)) {
      const leaf = leafFor(claim.address, BigInt(claim.cumulativeAmount));
      expect(verifies(claim.proof, document.root, leaf)).toBe(true);
    }
  });

  it('files a root under the index the chain actually gave it', async () => {
    // Not index + 1 by assumption: a second publisher, or a manual root, would
    // make the guess wrong and file proofs under a root index holding something
    // else entirely.
    const chain = fakeChain();
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000), chain });
    world.rewards.earn(PERIOD_0, ALICE, 1);

    await world.run();

    const onchain = await chain.currentRoot();
    expect(world.proofs.documents[0]?.rootIndex).toBe(onchain.index);
  });

  it('rewrites the files for a root that reached the chain but left no proofs behind', async () => {
    // The crash between the receipt and the file write. The root is live and
    // claimable, and without this everybody in it would be unable to claim
    // until the next time somebody happened to earn.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    const root = world.proofs.documents[0]!.root;
    world.proofs.documents.length = 0;

    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    const report = await world.run();

    expect(report.publish.kind).toBe('unchanged');
    expect(world.chain.attempted).toHaveLength(1);
    expect(world.proofs.documents[0]?.root).toBe(root);
  });

  it('does not rewrite files that are already there', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    await world.run();
    world.setNow(atPeriod(PERIOD_0 + 3, 20_000));
    await world.run();

    expect(world.proofs.documents).toHaveLength(1);
  });

  it('carries the cumulative total, not the period amount', async () => {
    // A leaf says what an address has ever earned. Publishing a period figure
    // would mean a recipient who missed a root lost that period forever.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 2);
    await world.run();

    world.rewards.earn(PERIOD_0 + 1, ALICE, 3);
    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    await world.run();

    const latest = world.proofs.documents[world.proofs.documents.length - 1]!;
    expect(latest.claims[ALICE]?.cumulativeAmount).toBe((5n * 10n ** 18n).toString());
  });
});

describe('A dry run', () => {
  it('does everything except send the transaction', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000), dryRun: true });
    world.rewards.earn(PERIOD_0, ALICE, 1);

    const report = await world.run();

    expect(report.publish.kind).toBe('published');
    expect(world.chain.attempted).toEqual([]);
    expect((await world.chain.currentRoot()).root).toBe(NO_ROOT);

    // The accrual is real, and the proof file is real - a rehearsal that
    // skipped those would not be rehearsing the part most likely to be wrong.
    expect(world.rewards.written).toEqual([PERIOD_0]);
    expect(world.proofs.documents).toHaveLength(1);
  });

  it('marks what it writes, so a rehearsal never reads as a real publication', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000), dryRun: true });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    expect(world.proofs.documents[0]?.dryRun).toBe(true);
  });

  it('still skips a root it has already decided not to send', async () => {
    // Otherwise a dry run would claim it was publishing every ten minutes and
    // never exercise the one behaviour it is most useful for checking.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000), dryRun: true });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    const report = await world.run();

    expect(report.publish.kind).toBe('unchanged');
  });
});
