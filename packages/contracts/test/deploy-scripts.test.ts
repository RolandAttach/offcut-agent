import { expect } from 'chai';
import hre from 'hardhat';
import { ZeroAddress, getAddress } from 'ethers';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDeploy } from '../scripts/deploy';
import { runSetToken } from '../scripts/set-token';
import { runStatus } from '../scripts/status';
import { captureIo } from '../scripts/lib/io';
import { ethersOf } from '../scripts/lib/hre';
import { attachRewards } from '../scripts/lib/rewards';
import type { DeploymentRecord } from '../scripts/lib/deployments';

/**
 * The launch-day scripts, driven the way a person will drive them.
 *
 * These are the three commands that will be run once each, against a chain with
 * the owner's money on it, by someone who cannot try again. There is no staging
 * rehearsal for "deploy the contract that holds the rewards", so the rehearsal
 * is here: every refusal these scripts can produce is exercised, because a
 * refusal that does not fire is indistinguishable from one that does not exist
 * until the morning it was supposed to fire.
 *
 * Two rules the tests are built around:
 *
 *   - Nothing touches a live rpc. The mainnet path is reached by telling
 *     runDeploy it is on a live network (`live: true`) while the in-process
 *     Hardhat node answers underneath it. That node is configured with chainId
 *     4663 already, so the mainnet branch is entered for the real reason -
 *     the chain id - and not by a flag that only the tests understand.
 *   - Nothing touches packages/contracts/deployments/. Every run is handed a
 *     fresh temp directory, so a test can never write, read or delete the
 *     record the launch actually depends on.
 */

const tempDirs: string[] = [];

function freshDeploymentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'offcut-deployments-'));
  tempDirs.push(dir);
  return dir;
}

function readRecordFile(path: string): DeploymentRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentRecord;
}

/** A TestToken, as much of it as these tests touch. */
interface TestTokenContract {
  getAddress(): Promise<string>;
  waitForDeployment(): Promise<unknown>;
  mint(to: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
}

async function deployTestToken(): Promise<TestTokenContract> {
  const factory = await ethersOf(hre).getContractFactory('TestToken');
  const token = (await factory.deploy()) as unknown as TestTokenContract;
  await token.waitForDeployment();
  return token;
}

async function addresses() {
  const [deployer, publisher, other] = await ethersOf(hre).getSigners();
  return {
    deployer: getAddress(deployer.address),
    publisher: getAddress(publisher.address),
    other: getAddress(other.address),
  };
}

/** A deployed proxy in its own temp directory, for the tests that need one. */
async function deployFresh() {
  const { publisher } = await addresses();
  const dir = freshDeploymentsDir();
  const io = captureIo();
  const result = await runDeploy(
    hre,
    { OFFCUT_PUBLISHER_ADDRESS: publisher },
    io,
    { deploymentsDir: dir }
  );
  return { dir, io, result };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('deploy.ts', () => {
  it('deploys, reads the contract back, and writes a record that matches the chain', async () => {
    const { deployer, publisher } = await addresses();
    const { io, result } = await deployFresh();

    expect(result.dryRun).to.equal(false);
    const record = result.record;
    if (!record) throw new Error('expected a record');

    // The record is only trustworthy if it says what the chain says.
    const rewards = await attachRewards(hre, record.proxy);
    expect(getAddress(await rewards.owner())).to.equal(deployer);
    expect(getAddress(await rewards.publisher())).to.equal(publisher);
    expect(getAddress(await rewards.token())).to.equal(ZeroAddress);
    expect(await rewards.paused()).to.equal(false);

    expect(record.owner).to.equal(deployer);
    expect(record.publisher).to.equal(publisher);
    expect(record.token).to.equal(null, 'the CA arrives last; deploy must never set it');
    expect(record.chainId).to.equal(4663);
    expect(record.deployer).to.equal(deployer);
    expect(record.txHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(record.blockNumber).to.be.a('number');
    expect(new Date(record.deployedAt).toISOString()).to.equal(record.deployedAt);
    expect(record.implementation).to.not.equal(record.proxy);
    expect(getAddress(record.implementation)).to.equal(
      getAddress(await hre.upgrades.erc1967.getImplementationAddress(record.proxy))
    );

    // A local rehearsal must not carry mainnet explorer links, even though the
    // in-process network answers 4663.
    expect(record.explorer.proxy).to.equal(null);

    expect(readRecordFile(result.recordPath)).to.deep.equal(record);

    const text = io.text();
    expect(text).to.include('Preflight');
    expect(text).to.include('estimated cost');
    expect(text).to.include('hardhat verify --network hardhat');
  });

  it('refuses a second deploy because the record already exists', async () => {
    const { publisher } = await addresses();
    const { dir, result } = await deployFresh();

    let refusal = '';
    try {
      await runDeploy(hre, { OFFCUT_PUBLISHER_ADDRESS: publisher }, captureIo(), {
        deploymentsDir: dir,
      });
      throw new Error('a second deploy was allowed');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('already been deployed to');
    expect(refusal).to.include('there is no --force');
    // The first record is untouched - the refusal must not have rewritten it.
    expect(readRecordFile(result.recordPath).proxy).to.equal(result.record?.proxy);
  });

  it('refuses a mainnet run without OFFCUT_DEPLOY_CONFIRM=mainnet', async () => {
    const { publisher } = await addresses();
    const dir = freshDeploymentsDir();

    let refusal = '';
    try {
      await runDeploy(hre, { OFFCUT_PUBLISHER_ADDRESS: publisher }, captureIo(), {
        deploymentsDir: dir,
        networkName: 'robinhood',
        live: true,
      });
      throw new Error('a mainnet deploy ran unconfirmed');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('MAINNET');
    expect(refusal).to.include('OFFCUT_DEPLOY_CONFIRM=mainnet');
    expect(refusal).to.include('Nothing has been sent');
    expect(existsSync(join(dir, 'robinhood.json'))).to.equal(false);
  });

  it('accepts the same mainnet run once the variable is set, and a dry run stops after preflight', async () => {
    // The companion to the test above: it proves the confirmation guard was the
    // only thing refusing, rather than some unrelated failure on that path.
    const { publisher } = await addresses();
    const dir = freshDeploymentsDir();
    const io = captureIo();

    const result = await runDeploy(
      hre,
      {
        OFFCUT_PUBLISHER_ADDRESS: publisher,
        OFFCUT_DEPLOY_CONFIRM: 'mainnet',
        OFFCUT_DEPLOY_DRY_RUN: '1',
      },
      io,
      { deploymentsDir: dir, networkName: 'robinhood', live: true }
    );

    expect(result.dryRun).to.equal(true);
    expect(result.record).to.equal(null);
    expect(io.text()).to.include('mainnet run confirmed');
    expect(io.text()).to.include('Nothing was sent');
    expect(existsSync(join(dir, 'robinhood.json'))).to.equal(false);
  });

  it('refuses an address that is not EIP-55 checksummed', async () => {
    const { publisher } = await addresses();
    const dir = freshDeploymentsDir();

    let refusal = '';
    try {
      await runDeploy(hre, { OFFCUT_PUBLISHER_ADDRESS: publisher.toLowerCase() }, captureIo(), {
        deploymentsDir: dir,
      });
      throw new Error('a lower-cased publisher address was accepted');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('OFFCUT_PUBLISHER_ADDRESS');
    expect(refusal).to.include('not EIP-55 checksummed');
    expect(refusal).to.include(publisher);
  });

  it('says loudly when the owner is not the deployer, and deploys anyway', async () => {
    // A hardware-wallet owner is the expected shape on launch day, so this must
    // not refuse - but the deployer losing every power over the contract is not
    // something to discover later.
    const { deployer, publisher, other } = await addresses();
    const dir = freshDeploymentsDir();
    const io = captureIo();

    const result = await runDeploy(
      hre,
      { OFFCUT_PUBLISHER_ADDRESS: publisher, OFFCUT_OWNER_ADDRESS: other },
      io,
      { deploymentsDir: dir }
    );

    expect(result.record?.owner).to.equal(other);
    expect(result.record?.deployer).to.equal(deployer);
    expect(io.text()).to.include('OWNER IS NOT THE DEPLOYER');

    const rewards = await attachRewards(hre, result.record!.proxy);
    expect(getAddress(await rewards.owner())).to.equal(other);
  });
});

// ---------------------------------------------------------------------------
describe('set-token.ts', () => {
  async function deployToken(): Promise<string> {
    return getAddress(await (await deployTestToken()).getAddress());
  }

  it('refuses a token address that is not EIP-55 checksummed', async () => {
    const { dir } = await deployFresh();
    const token = await deployToken();

    let refusal = '';
    try {
      await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: token.toLowerCase() }, captureIo(), {
        deploymentsDir: dir,
      });
      throw new Error('a lower-cased token address was accepted');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('not EIP-55 checksummed');
    expect(refusal).to.include(token);
  });

  it('refuses an address with no code on it', async () => {
    const { dir } = await deployFresh();
    const { other } = await addresses();

    let refusal = '';
    try {
      await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: other }, captureIo(), {
        deploymentsDir: dir,
      });
      throw new Error('an EOA was accepted as the token');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('no contract at');
    expect(refusal).to.include('one-shot');
  });

  it('sets the token once, reads it back, and updates the record', async () => {
    const { dir, result } = await deployFresh();
    const token = await deployToken();
    const io = captureIo();

    const outcome = await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: token }, io, {
      deploymentsDir: dir,
    });

    expect(outcome.token).to.equal(token);
    expect(outcome.txHash).to.match(/^0x[0-9a-f]{64}$/);

    const rewards = await attachRewards(hre, result.record!.proxy);
    expect(getAddress(await rewards.token())).to.equal(token);

    const record = readRecordFile(result.recordPath);
    expect(record.token).to.equal(token);
    expect(record.tokenTxHash).to.equal(outcome.txHash);
    expect(new Date(record.tokenSetAt!).toISOString()).to.equal(record.tokenSetAt);
    // The deploy fields survive the update: the record is added to, not rewritten.
    expect(record.proxy).to.equal(result.record!.proxy);
    expect(record.txHash).to.equal(result.record!.txHash);
  });

  it('refuses when the token is already set', async () => {
    const { dir } = await deployFresh();
    const first = await deployToken();
    const second = await deployToken();

    await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: first }, captureIo(), { deploymentsDir: dir });

    let refusal = '';
    try {
      await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: second }, captureIo(), {
        deploymentsDir: dir,
      });
      throw new Error('the token was set twice');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('already set to');
    expect(refusal).to.include(first);
    expect(refusal).to.include('TokenAlreadySet');
  });

  it('refuses when the configured key is not the owner', async () => {
    // The contract would revert anyway; refusing first saves the gas and says
    // which address the caller actually needs.
    const { publisher, other } = await addresses();
    const dir = freshDeploymentsDir();
    await runDeploy(
      hre,
      { OFFCUT_PUBLISHER_ADDRESS: publisher, OFFCUT_OWNER_ADDRESS: other },
      captureIo(),
      { deploymentsDir: dir }
    );
    const token = await deployToken();

    let refusal = '';
    try {
      await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: token }, captureIo(), {
        deploymentsDir: dir,
      });
      throw new Error('a non-owner was allowed to call setToken');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('owner-only');
    expect(refusal).to.include(other);
  });

  it('refuses a mainnet set-token without the confirmation variable', async () => {
    const { dir } = await deployFresh();
    const token = await deployToken();

    let refusal = '';
    try {
      await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: token }, captureIo(), {
        deploymentsDir: dir,
        networkName: 'hardhat',
        live: true,
      });
      throw new Error('a mainnet set-token ran unconfirmed');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('OFFCUT_DEPLOY_CONFIRM=mainnet');
  });
});

// ---------------------------------------------------------------------------
describe('status.ts', () => {
  it('prints the whole picture of a fresh deployment without throwing', async () => {
    const { deployer, publisher } = await addresses();
    const { dir, result } = await deployFresh();
    const io = captureIo();

    const summary = await runStatus(hre, {}, io, { deploymentsDir: dir });

    expect(summary.proxy).to.equal(result.record!.proxy);
    expect(summary.owner).to.equal(deployer);
    expect(summary.publisher).to.equal(publisher);
    expect(summary.token).to.equal(null);
    expect(summary.paused).to.equal(false);
    expect(summary.rootIndex).to.equal(0n);
    expect(summary.pendingOwner).to.equal(null);
    expect(summary.balances.owner).to.be.a('bigint');
    expect(summary.balances.publisher).to.be.a('bigint');

    const text = io.text();
    expect(text).to.include('owner()');
    expect(text).to.include('publisher()');
    expect(text).to.include('claim() reverts TokenNotSet');
    expect(text).to.include('nothing published yet');
  });

  it('reports the pool once the token is set and funded', async () => {
    const { dir, result } = await deployFresh();
    const token = await deployTestToken();
    const tokenAddress = getAddress(await token.getAddress());

    await runSetToken(hre, { OFFCUT_TOKEN_ADDRESS: tokenAddress }, captureIo(), {
      deploymentsDir: dir,
    });
    await token.mint(result.record!.proxy, 10n ** 18n * 250n);

    const io = captureIo();
    const summary = await runStatus(hre, {}, io, { deploymentsDir: dir });

    expect(summary.token).to.equal(tokenAddress);
    expect(summary.proxyTokenBalance).to.equal(10n ** 18n * 250n);
    expect(io.text()).to.include('Reward pool');
    expect(io.text()).to.include('250.0');
  });

  it('refuses when there is no record and no address to fall back on', async () => {
    const dir = freshDeploymentsDir();

    let refusal = '';
    try {
      await runStatus(hre, {}, captureIo(), { deploymentsDir: dir });
      throw new Error('status reported on nothing');
    } catch (error) {
      refusal = (error as Error).message;
    }

    expect(refusal).to.include('No deployment record');
    expect(refusal).to.include('OFFCUT_CONTRACT_ADDRESS');
  });
});
