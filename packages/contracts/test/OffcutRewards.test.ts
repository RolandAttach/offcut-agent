import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { MerkleTree, leafOf, type Entry } from './merkle';

/**
 * The reward distributor.
 *
 * This contract holds money, so the tests are written around the ways it could
 * lose it rather than around the happy path. Four groups:
 *
 *   - a claim pays exactly what was earned and never twice
 *   - a proof that was not published cannot be spent
 *   - the publisher key, which lives on a server and will eventually leak,
 *     can misdirect future rewards and cannot take a single token
 *   - the owner's powers are real, complete, and behave as the page says
 */

const UNIT = 10n ** 18n;

async function deploy() {
  const [owner, publisher, alice, bob, carol, stranger] = await ethers.getSigners();

  const Token = await ethers.getContractFactory('TestToken');
  const token = await Token.deploy();

  const Rewards = await ethers.getContractFactory('OffcutRewards');
  const rewards = await upgrades.deployProxy(
    Rewards,
    [owner.address, publisher.address, await token.getAddress()],
    { kind: 'uups' }
  );

  await token.mint(await rewards.getAddress(), 1_000_000n * UNIT);

  return { rewards, token, owner, publisher, alice, bob, carol, stranger };
}

function treeFor(entries: Entry[]): MerkleTree {
  return new MerkleTree(entries);
}

async function publish(
  rewards: Awaited<ReturnType<typeof deploy>>['rewards'],
  publisher: HardhatEthersSigner,
  entries: Entry[]
): Promise<MerkleTree> {
  const tree = treeFor(entries);
  await rewards.connect(publisher).publishRoot(tree.root);
  return tree;
}

// ---------------------------------------------------------------------------
describe('Claiming pays what was earned, once', () => {
  it('pays the full amount on a first claim', async () => {
    const { rewards, token, publisher, alice, bob } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 10n * UNIT },
      { account: bob.address, cumulativeAmount: 3n * UNIT },
    ]);

    await rewards.claim(alice.address, 10n * UNIT, tree.proofFor(alice.address));

    expect(await token.balanceOf(alice.address)).to.equal(10n * UNIT);
    expect(await rewards.claimed(alice.address)).to.equal(10n * UNIT);
    expect(await rewards.totalClaimed()).to.equal(10n * UNIT);
  });

  it('pays only the difference when a later root raises the total', async () => {
    // This is what "cumulative" buys: the second root carries everything ever
    // earned, and the claim settles the gap rather than paying twice.
    const { rewards, token, publisher, alice } = await deploy();

    const first = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 10n * UNIT },
    ]);
    await rewards.claim(alice.address, 10n * UNIT, first.proofFor(alice.address));

    const second = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 25n * UNIT },
    ]);
    await rewards.claim(alice.address, 25n * UNIT, second.proofFor(alice.address));

    expect(await token.balanceOf(alice.address)).to.equal(25n * UNIT);
    expect(await rewards.totalClaimed()).to.equal(25n * UNIT);
  });

  it('refuses a second claim against the same root', async () => {
    const { rewards, publisher, alice } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 10n * UNIT },
    ]);

    await rewards.claim(alice.address, 10n * UNIT, tree.proofFor(alice.address));

    await expect(
      rewards.claim(alice.address, 10n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'NothingToClaim');
  });

  it('lets a recipient skip roots and claim once at the end', async () => {
    // With a root every ten minutes, most people will. Missing a hundred roots
    // must cost nothing.
    const { rewards, token, publisher, alice } = await deploy();

    for (const total of [1n, 5n, 12n, 30n]) {
      await publish(rewards, publisher, [{ account: alice.address, cumulativeAmount: total * UNIT }]);
    }
    const last = treeFor([{ account: alice.address, cumulativeAmount: 30n * UNIT }]);

    await rewards.claim(alice.address, 30n * UNIT, last.proofFor(alice.address));

    expect(await token.balanceOf(alice.address)).to.equal(30n * UNIT);
  });

  it('lets anyone pay the gas, but pays only the named account', async () => {
    const { rewards, token, publisher, alice, stranger } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 7n * UNIT },
    ]);

    await rewards.connect(stranger).claim(alice.address, 7n * UNIT, tree.proofFor(alice.address));

    expect(await token.balanceOf(alice.address)).to.equal(7n * UNIT);
    expect(await token.balanceOf(stranger.address)).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
describe('A proof that was not published cannot be spent', () => {
  it('rejects an amount larger than the one in the tree', async () => {
    const { rewards, publisher, alice } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 10n * UNIT },
    ]);

    await expect(
      rewards.claim(alice.address, 1_000n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'InvalidProof');
  });

  it("rejects one account's proof used for another", async () => {
    const { rewards, publisher, alice, bob } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 10n * UNIT },
      { account: bob.address, cumulativeAmount: 3n * UNIT },
    ]);

    await expect(
      rewards.claim(bob.address, 10n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'InvalidProof');
  });

  it('rejects a proof from a tree that was never published', async () => {
    const { rewards, publisher, alice, carol } = await deploy();
    await publish(rewards, publisher, [{ account: alice.address, cumulativeAmount: 10n * UNIT }]);

    const forged = treeFor([{ account: carol.address, cumulativeAmount: 500n * UNIT }]);

    await expect(
      rewards.claim(carol.address, 500n * UNIT, forged.proofFor(carol.address))
    ).to.be.revertedWithCustomError(rewards, 'InvalidProof');
  });

  it('cannot be tricked by passing an internal node as a leaf', async () => {
    // The reason leaves are hashed twice. With single hashing, a 64-byte
    // "leaf" can be made to collide with an internal node and a proof forged
    // for an amount nobody earned.
    const { rewards, publisher, alice, bob } = await deploy();
    const entries: Entry[] = [
      { account: alice.address, cumulativeAmount: 10n * UNIT },
      { account: bob.address, cumulativeAmount: 3n * UNIT },
    ];
    const tree = await publish(rewards, publisher, entries);

    // The internal node above both leaves is the root itself here; offering it
    // as a leaf with an empty proof must not verify.
    await expect(rewards.claim(alice.address, 10n * UNIT, [])).to.be.revertedWithCustomError(
      rewards,
      'InvalidProof'
    );
    expect(leafOf(entries[0]!)).to.not.equal(tree.root);
  });

  it('pays nothing before the first root exists', async () => {
    const { rewards, alice } = await deploy();

    await expect(rewards.claim(alice.address, 1n * UNIT, [])).to.be.revertedWithCustomError(
      rewards,
      'NoRoot'
    );
  });

  it('refuses to pay more than it holds rather than paying partially', async () => {
    const { rewards, token, owner, publisher, alice } = await deploy();
    // Empty the contract, as an owner withdrawal would.
    await rewards.connect(owner).withdraw(owner.address, await token.balanceOf(await rewards.getAddress()));

    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 5n * UNIT },
    ]);

    await expect(
      rewards.claim(alice.address, 5n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'InsufficientBalance');

    // And the failed attempt left no trace that would block a later, funded one.
    expect(await rewards.claimed(alice.address)).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
describe('A token that takes a cut of transfers', () => {
  /**
   * The OFFCUT token is being launched through a venue whose tokens sometimes
   * carry a transfer tax. A distributor that ignores that credits people for
   * the full amount and delivers less — every recipient short, no number
   * anywhere showing it. These pin the loud failure instead.
   */
  async function deployTaxed() {
    const [owner, publisher, alice] = await ethers.getSigners();

    const Taxed = await ethers.getContractFactory('TaxedToken');
    const token = await Taxed.deploy();

    const Rewards = await ethers.getContractFactory('OffcutRewards');
    const rewards = await upgrades.deployProxy(
      Rewards,
      [owner.address, publisher.address, await token.getAddress()],
      { kind: 'uups' }
    );

    await token.mint(await rewards.getAddress(), 1_000n * UNIT);
    return { rewards, token, owner, publisher, alice };
  }

  it('reverts rather than paying 95% and recording 100%', async () => {
    const { rewards, publisher, alice } = await deployTaxed();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 100n * UNIT },
    ]);

    await expect(
      rewards.claim(alice.address, 100n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'TransferShortfall');
  });

  it('leaves nothing recorded, so the claim works once the fee is fixed', async () => {
    // The revert must roll back `claimed` too, or exempting the distributor
    // from the tax afterwards would still leave the recipient unable to claim.
    const { rewards, token, publisher, alice } = await deployTaxed();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 100n * UNIT },
    ]);

    await expect(rewards.claim(alice.address, 100n * UNIT, tree.proofFor(alice.address))).to.be
      .reverted;

    expect(await rewards.claimed(alice.address)).to.equal(0n);
    expect(await rewards.totalClaimed()).to.equal(0n);
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
describe('The publisher key can misdirect rewards and cannot take them', () => {
  it('is the only key that can publish', async () => {
    const { rewards, owner, alice, stranger } = await deploy();
    const tree = treeFor([{ account: alice.address, cumulativeAmount: 1n * UNIT }]);

    await expect(rewards.connect(stranger).publishRoot(tree.root)).to.be.revertedWithCustomError(
      rewards,
      'NotPublisher'
    );
    // Not even the owner, who must change the publisher rather than act as one.
    await expect(rewards.connect(owner).publishRoot(tree.root)).to.be.revertedWithCustomError(
      rewards,
      'NotPublisher'
    );
  });

  it('cannot withdraw, upgrade, pause or replace itself', async () => {
    // The whole point of splitting the roles: this key signs every ten minutes
    // from a server, so assume it leaks, and make that survivable.
    const { rewards, publisher, stranger } = await deploy();

    for (const call of [
      rewards.connect(publisher).withdraw(publisher.address, 1n),
      rewards.connect(publisher).setPublisher(stranger.address),
      rewards.connect(publisher).pause(),
      rewards.connect(publisher).setToken(stranger.address),
    ]) {
      await expect(call).to.be.revertedWithCustomError(rewards, 'OwnableUnauthorizedAccount');
    }
  });

  it('can be replaced by the owner, after which the old key is inert', async () => {
    const { rewards, owner, publisher, carol, alice } = await deploy();
    const tree = treeFor([{ account: alice.address, cumulativeAmount: 1n * UNIT }]);

    await rewards.connect(owner).setPublisher(carol.address);

    await expect(rewards.connect(publisher).publishRoot(tree.root)).to.be.revertedWithCustomError(
      rewards,
      'NotPublisher'
    );
    await expect(rewards.connect(carol).publishRoot(tree.root)).to.not.be.reverted;
  });

  it('cannot publish an empty root, which would strand every claim', async () => {
    const { rewards, publisher } = await deploy();

    await expect(rewards.connect(publisher).publishRoot(ethers.ZeroHash)).to.be.revertedWithCustomError(
      rewards,
      'NoRoot'
    );
  });

  it('can lower an amount, and an over-paid account is simply owed nothing more', async () => {
    // What happens when a farm is found after it was paid: the next root drops
    // them. Nothing is clawed back, because this contract cannot take money.
    const { rewards, token, publisher, alice } = await deploy();

    const generous = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 100n * UNIT },
    ]);
    await rewards.claim(alice.address, 100n * UNIT, generous.proofFor(alice.address));

    const corrected = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 5n * UNIT },
    ]);

    await expect(
      rewards.claim(alice.address, 5n * UNIT, corrected.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'NothingToClaim');
    expect(await token.balanceOf(alice.address)).to.equal(100n * UNIT);
  });
});

// ---------------------------------------------------------------------------
describe("The owner's powers are what the page says they are", () => {
  it('can withdraw everything, which is the risk that is disclosed', async () => {
    const { rewards, token, owner } = await deploy();
    const balance = await token.balanceOf(await rewards.getAddress());

    await rewards.connect(owner).withdraw(owner.address, balance);

    expect(await token.balanceOf(await rewards.getAddress())).to.equal(0n);
    expect(await token.balanceOf(owner.address)).to.equal(balance);
  });

  it('cannot withdraw more than the contract holds', async () => {
    const { rewards, token, owner } = await deploy();
    const balance = await token.balanceOf(await rewards.getAddress());

    await expect(
      rewards.connect(owner).withdraw(owner.address, balance + 1n)
    ).to.be.revertedWithCustomError(rewards, 'InsufficientBalance');
  });

  it('names the token once and refuses to change it afterwards', async () => {
    // Changing it after a claim would make `claimed` mean two different assets.
    const { rewards, owner, stranger } = await deploy();

    await expect(rewards.connect(owner).setToken(stranger.address)).to.be.revertedWithCustomError(
      rewards,
      'TokenAlreadySet'
    );
  });

  it('can be deployed before the token exists, and pays once it is named', async () => {
    // The expected order: this contract ships, the token launches later.
    const [owner, publisher, alice] = await ethers.getSigners();
    const Rewards = await ethers.getContractFactory('OffcutRewards');
    const rewards = await upgrades.deployProxy(
      Rewards,
      [owner.address, publisher.address, ethers.ZeroAddress],
      { kind: 'uups' }
    );

    const tree = treeFor([{ account: alice.address, cumulativeAmount: 4n * UNIT }]);
    await rewards.connect(publisher).publishRoot(tree.root);

    await expect(
      rewards.claim(alice.address, 4n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'TokenNotSet');

    const Token = await ethers.getContractFactory('TestToken');
    const token = await Token.deploy();
    await token.mint(await rewards.getAddress(), 100n * UNIT);
    await rewards.connect(owner).setToken(await token.getAddress());

    await rewards.claim(alice.address, 4n * UNIT, tree.proofFor(alice.address));
    expect(await token.balanceOf(alice.address)).to.equal(4n * UNIT);
  });

  it('pausing stops publishing and claiming, and never blocks withdrawal', async () => {
    const { rewards, token, owner, publisher, alice } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 2n * UNIT },
    ]);

    await rewards.connect(owner).pause();

    await expect(
      rewards.claim(alice.address, 2n * UNIT, tree.proofFor(alice.address))
    ).to.be.revertedWithCustomError(rewards, 'EnforcedPause');
    await expect(rewards.connect(publisher).publishRoot(tree.root)).to.be.revertedWithCustomError(
      rewards,
      'EnforcedPause'
    );
    // An owner must be able to rescue funds from a paused contract.
    await expect(rewards.connect(owner).withdraw(owner.address, 1n * UNIT)).to.not.be.reverted;

    await rewards.connect(owner).unpause();
    await rewards.claim(alice.address, 2n * UNIT, tree.proofFor(alice.address));
    expect(await token.balanceOf(alice.address)).to.equal(2n * UNIT);
  });

  it('transfers ownership in two steps, so a typo cannot orphan the contract', async () => {
    const { rewards, owner, carol } = await deploy();

    await rewards.connect(owner).transferOwnership(carol.address);
    expect(await rewards.owner()).to.equal(owner.address); // not yet

    await rewards.connect(carol).acceptOwnership();
    expect(await rewards.owner()).to.equal(carol.address);
  });

  it('is the only one who can upgrade, and state survives the upgrade', async () => {
    const { rewards, publisher, alice, stranger } = await deploy();
    const tree = await publish(rewards, publisher, [
      { account: alice.address, cumulativeAmount: 6n * UNIT },
    ]);
    await rewards.claim(alice.address, 6n * UNIT, tree.proofFor(alice.address));

    const Rewards = await ethers.getContractFactory('OffcutRewards');
    const asStranger = Rewards.connect(stranger);
    await expect(
      upgrades.upgradeProxy(await rewards.getAddress(), asStranger)
    ).to.be.revertedWithCustomError(rewards, 'OwnableUnauthorizedAccount');

    const upgraded = await upgrades.upgradeProxy(await rewards.getAddress(), Rewards);
    expect(await upgraded.claimed(alice.address)).to.equal(6n * UNIT);
    expect(await upgraded.merkleRoot()).to.equal(tree.root);
  });

  it('refuses a zero address wherever one would break it', async () => {
    const { rewards, owner } = await deploy();

    await expect(
      rewards.connect(owner).setPublisher(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(rewards, 'ZeroAddress');
    await expect(
      rewards.connect(owner).withdraw(ethers.ZeroAddress, 1n)
    ).to.be.revertedWithCustomError(rewards, 'ZeroAddress');
  });

  it('locks the implementation so nobody can initialise it directly', async () => {
    const Rewards = await ethers.getContractFactory('OffcutRewards');
    const implementation = await Rewards.deploy();
    const [owner, publisher] = await ethers.getSigners();

    await expect(
      implementation.initialize(owner.address, publisher.address, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(implementation, 'InvalidInitialization');
  });
});
