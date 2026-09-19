import { ZeroAddress, getAddress, formatEther, formatUnits } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';

import { consoleIo, field, heading, type Io } from './lib/io';
import { flag, optionalAddress, type Env } from './lib/env';
import {
  MAINNET_CONFIRM_VALUE,
  MAINNET_CONFIRM_VAR,
  explorerAddressUrl,
  explorerTxUrl,
  isDryRun,
  requireMainnetConfirmation,
  resolveNetwork,
  type NetworkOverrides,
} from './lib/network';
import {
  deploymentsDir,
  readRecord,
  recordPath,
  writeRecord,
  type DeploymentRecord,
} from './lib/deployments';
import { attachRewards } from './lib/rewards';
import { ethersOf } from './lib/hre';

/**
 * Deploys OffcutRewards behind a UUPS proxy. Once, on purpose, with the whole
 * preflight printed before a single byte is sent.
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 *
 * On launch day someone runs this against a chain holding the owner's ETH, from
 * a terminal, once. Everything expensive about that sentence is a design
 * constraint:
 *
 *   - "once"      - a second proxy is not an error the chain reports. It is a
 *                   second contract, funded rewards pointing at the first, and
 *                   a site configured for whichever address was pasted last.
 *                   The deployment record is the interlock: if the file exists,
 *                   this refuses. There is no --force, by request: deleting the
 *                   file by hand is slow enough to be deliberate.
 *   - "a chain"   - not the chain it was told about. eth_chainId is read and
 *                   compared before anything else happens.
 *   - "the owner's ETH" - balance, gas price and the estimated cost are printed
 *                   first, and a balance under three times the estimate refuses
 *                   rather than half-deploying. A proxy without an
 *                   implementation is the worst outcome available here.
 *
 * The private key is never touched by this file. It reaches hardhat through
 * OFFCUT_DEPLOYER_KEY in hardhat.config.ts, and nothing below reads, prints or
 * copies it - the deployer is only ever known here by its address.
 *
 * ---------------------------------------------------------------------------
 * The token is deliberately absent
 * ---------------------------------------------------------------------------
 *
 * initialize() is always called with token = address(0). The OFFCUT contract
 * address arrives LAST, after this contract exists and has been funded, and
 * `setToken` names it then. Until that call, claim() reverts TokenNotSet and
 * roots accrue regardless - which is the sequence the contract was written for.
 */

/**
 * The proxy's deployment gas, measured rather than estimated.
 *
 * The implementation can be estimated exactly - it is an ordinary create - but
 * the ERC1967 proxy cannot be, because its constructor delegatecalls
 * initialize() on an implementation that does not exist yet, and eth_estimateGas
 * on that reverts. So the figure below is a measurement: 208,362 gas for the
 * proxy on the local network, rounded up for an Orbit chain that folds its L1
 * data cost into gas and will not report the same number. The preflight calls
 * the total an estimate, and the 3x balance floor is what actually covers the
 * difference.
 */
const PROXY_DEPLOY_GAS = 260_000n;

/** How many confirmations to wait for before reading the contract back. */
const LIVE_CONFIRMATIONS = 2;

export interface DeployOptions extends NetworkOverrides {
  /** Tests pass a temp directory; OFFCUT_DEPLOYMENTS_DIR does the same. */
  deploymentsDir?: string;
}

export interface DeployResult {
  record: DeploymentRecord | null;
  recordPath: string;
  /** True when OFFCUT_DEPLOY_DRY_RUN=1 stopped the run after preflight. */
  dryRun: boolean;
}

export async function runDeploy(
  hre: HardhatRuntimeEnvironment,
  env: Env,
  io: Io,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const net = await resolveNetwork(hre, options);
  const dir = deploymentsDir(env, options.deploymentsDir);
  const path = recordPath(dir, net.name);

  heading(io, `OFFCUT rewards - deploy to ${net.name}`);

  // Before anything else: has this network been deployed to already? The answer
  // that matters is on disk, not on the chain - see the header.
  const existing = readRecord(path);
  if (existing) {
    throw new Error(
      `${net.name} has already been deployed to.\n` +
        `  record ${path}\n` +
        `  proxy  ${existing.proxy}\n` +
        '  Refusing. If you truly mean to deploy a second contract, delete that file\n' +
        '  by hand first - there is no --force here on purpose.'
    );
  }

  const eth = ethersOf(hre);
  const signers = await eth.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      `Network "${net.name}" has no account configured. Set OFFCUT_DEPLOYER_KEY in the ` +
        'environment (hardhat.config.ts reads it) and run again.'
    );
  }

  const publisher = resolvePublisher(env, signers, net.live, io);
  const owner = optionalAddress(env, 'OFFCUT_OWNER_ADDRESS') ?? getAddress(deployer.address);

  // -- preflight ------------------------------------------------------------
  const balance = await eth.provider.getBalance(deployer.address);
  const feeData = await eth.provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice === null || gasPrice === undefined) {
    throw new Error('The node reported no gas price. Refusing to guess what a deploy costs.');
  }

  const Rewards = await eth.getContractFactory('OffcutRewards');
  const implGas = await eth.provider.estimateGas({
    ...(await Rewards.getDeployTransaction()),
    from: deployer.address,
  });
  const totalGas = implGas + PROXY_DEPLOY_GAS;
  const estimatedCost = totalGas * gasPrice;
  const floor = estimatedCost * 3n;

  heading(io, 'Preflight');
  field(io, 'network', `${net.name}${net.live ? '' : '  (in-process, not a live chain)'}`);
  field(
    io,
    'chain id',
    `${net.chainId}  (configured ${net.configuredChainId}, confirmed by eth_chainId)`
  );
  field(io, 'deployer', getAddress(deployer.address));
  field(io, 'deployer balance', `${formatEther(balance)} ETH`);
  field(io, 'gas price', `${formatUnits(gasPrice, 'gwei')} gwei`);
  field(io, 'implementation gas', `${implGas} (estimated)`);
  field(io, 'proxy gas', `${PROXY_DEPLOY_GAS} (measured locally, see PROXY_DEPLOY_GAS)`);
  field(io, 'estimated cost', `${formatEther(estimatedCost)} ETH`);
  field(io, 'required balance', `${formatEther(floor)} ETH  (3x the estimate)`);
  field(io, 'owner to be set', owner);
  field(io, 'publisher to be set', publisher);
  field(io, 'token to be set', `${ZeroAddress}  (the CA arrives last; setToken names it)`);
  field(io, 'record to write', path);

  if (owner !== getAddress(deployer.address)) {
    io.warn('');
    io.warn('  !! OWNER IS NOT THE DEPLOYER.');
    io.warn(`  !! owner    ${owner}`);
    io.warn(`  !! deployer ${getAddress(deployer.address)}`);
    io.warn('  !! Deploying anyway - a hardware wallet or multisig owner is expected. But the');
    io.warn('  !! deployer will have NO powers over this contract once it exists: no withdraw,');
    io.warn('  !! no upgrade, no pause, no setToken. Stop now if that address is a typo.');
  }

  if (balance < floor) {
    throw new Error(
      'Deployer balance is below three times the estimated cost.\n' +
        `  balance   ${formatEther(balance)} ETH\n` +
        `  estimate  ${formatEther(estimatedCost)} ETH\n` +
        `  required  ${formatEther(floor)} ETH\n` +
        '  Refusing: running out of gas between the implementation and the proxy leaves\n' +
        '  an implementation nothing points at. Fund the deployer and run again.'
    );
  }

  requireMainnetConfirmation(env, net);
  if (net.mainnet) {
    io.log('');
    io.log(`  ${MAINNET_CONFIRM_VAR}=${MAINNET_CONFIRM_VALUE} - mainnet run confirmed.`);
  }

  if (isDryRun(env)) {
    io.log('');
    io.log('  OFFCUT_DEPLOY_DRY_RUN=1 - preflight only. Nothing was sent.');
    return { record: null, recordPath: path, dryRun: true };
  }

  // -- deploy ---------------------------------------------------------------
  heading(io, 'Deploying');
  io.log('  upgrades.deployProxy(OffcutRewards, [owner, publisher, 0x0], { kind: "uups" })');

  const proxy = await hre.upgrades.deployProxy(Rewards, [owner, publisher, ZeroAddress], {
    kind: 'uups',
  });
  await proxy.waitForDeployment();

  const deployTx = proxy.deploymentTransaction();
  if (!deployTx) {
    throw new Error('The proxy reported no deployment transaction. Refusing to write a record.');
  }
  const receipt = await deployTx.wait(net.live ? LIVE_CONFIRMATIONS : 1);
  if (!receipt) {
    throw new Error(`No receipt for ${deployTx.hash}. Check the explorer before running again.`);
  }

  const proxyAddress = getAddress(await proxy.getAddress());
  const implementation = getAddress(
    await hre.upgrades.erc1967.getImplementationAddress(proxyAddress)
  );

  // -- read back ------------------------------------------------------------
  // The arguments we passed are what we asked for. These four are what the
  // chain says is true, and a mismatch means the record must not be written.
  const rewards = await attachRewards(hre, proxyAddress);
  const onChain = {
    owner: getAddress(await rewards.owner()),
    publisher: getAddress(await rewards.publisher()),
    token: getAddress(await rewards.token()),
    paused: await rewards.paused(),
  };

  heading(io, 'Read back from the proxy');
  field(io, 'owner()', onChain.owner);
  field(io, 'publisher()', onChain.publisher);
  field(io, 'token()', `${onChain.token}  (unset, as intended)`);
  field(io, 'paused()', String(onChain.paused));

  assertMatch('owner()', onChain.owner, owner);
  assertMatch('publisher()', onChain.publisher, publisher);
  assertMatch('token()', onChain.token, ZeroAddress);
  if (onChain.paused) {
    throw new Error(
      'The freshly deployed contract reports paused() == true. Refusing to record it.'
    );
  }

  const record: DeploymentRecord = {
    network: net.name,
    chainId: Number(net.chainId),
    proxy: proxyAddress,
    implementation,
    owner: onChain.owner,
    publisher: onChain.publisher,
    token: null,
    deployer: getAddress(deployer.address),
    txHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    explorer: {
      proxy: explorerAddressUrl(net, proxyAddress),
      implementation: explorerAddressUrl(net, implementation),
      deployTx: explorerTxUrl(net, deployTx.hash),
    },
  };

  try {
    writeRecord(path, record);
  } catch (error) {
    // The contract exists whatever happens to the file. Print the record so the
    // addresses survive a full disk or a bad path.
    io.error('');
    io.error('  THE CONTRACT IS DEPLOYED but the record could not be written. Save this:');
    io.error(JSON.stringify(record, null, 2));
    throw error;
  }

  // -- summary --------------------------------------------------------------
  heading(io, 'Deployed');
  field(io, 'proxy', proxyAddress);
  field(io, 'implementation', implementation);
  field(io, 'owner', record.owner);
  field(io, 'publisher', record.publisher);
  field(io, 'token', 'not set - run set-token once the OFFCUT CA exists');
  field(io, 'tx', `${record.txHash} (block ${record.blockNumber})`);
  field(io, 'record', path);
  if (record.explorer.proxy) field(io, 'explorer', record.explorer.proxy);

  const verifyCommand = `hardhat verify --network ${net.name} ${implementation}`;
  io.log('');
  io.log('  Verify the implementation next (blockscout, no api key needed):');
  io.log(`    pnpm --filter @offcut/contracts exec ${verifyCommand}`);
  io.log('');
  io.log('  Then: fund the proxy with OFFCUT, run set-token, run status.');

  if (!net.live) {
    // `hardhat run --network hardhat` starts a chain that dies with the
    // process. The record it leaves behind describes a contract that no longer
    // exists, and the next rehearsal will refuse because of it - which is the
    // guard working, not a bug.
    io.log('');
    io.log('  This was the in-process network: the chain is gone when this process exits.');
    io.log(`  Delete ${path} before rehearsing again.`);
  }

  if (flag(env, 'OFFCUT_DEPLOY_VERIFY')) {
    await tryVerify(hre, io, implementation, verifyCommand);
  }

  return { record, recordPath: path, dryRun: false };
}

/**
 * The publisher address, and the one case where it may be omitted.
 *
 * On a live chain it is required and must be checksummed: it is the key the
 * server signs roots with, and there is no recovering from initialising with
 * the wrong one except an owner call nobody has budgeted for. On the in-process
 * network there are no real addresses to paste, so `deploy:local` is allowed to
 * fall back to the second hardhat account - loudly, because seeing that line on
 * a live run would mean something is very wrong.
 */
function resolvePublisher(
  env: Env,
  signers: readonly { address: string }[],
  live: boolean,
  io: Io
): string {
  const given = optionalAddress(env, 'OFFCUT_PUBLISHER_ADDRESS');
  if (given) return given;

  if (live) {
    throw new Error(
      'OFFCUT_PUBLISHER_ADDRESS is required. Set it to the checksummed publisher address ' +
        '(the key that will live on the server and publish roots) and run again.'
    );
  }

  const fallback = signers[1];
  if (!fallback) {
    throw new Error('OFFCUT_PUBLISHER_ADDRESS is unset and this network has no second account.');
  }

  io.warn('');
  io.warn('  OFFCUT_PUBLISHER_ADDRESS is unset - using the second local account,');
  io.warn(`  ${getAddress(fallback.address)}. Local rehearsal only.`);
  return getAddress(fallback.address);
}

function assertMatch(what: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what} read back as ${actual}, not ${expected}. The deployment did not do what it was ` +
        'asked. No record has been written; investigate on the explorer before doing anything else.'
    );
  }
}

/**
 * Verification is a convenience, never a gate.
 *
 * A blockscout that is slow, rate-limiting, or has not indexed the block yet
 * must not turn a successful deploy into a failed script run - the contract is
 * already on the chain and the record is already written. So this swallows
 * everything and prints the command to run by hand later.
 */
async function tryVerify(
  hre: HardhatRuntimeEnvironment,
  io: Io,
  implementation: string,
  verifyCommand: string
): Promise<void> {
  heading(io, 'Verifying implementation');
  try {
    await hre.run('verify:verify', { address: implementation, constructorArguments: [] });
    io.log('  Verified.');
  } catch (error) {
    io.warn(`  Verification did not complete: ${(error as Error).message}`);
    io.warn(`  The deploy is unaffected. Run this later: ${verifyCommand}`);
  }
}

if (require.main === module) {
  const hre = require('hardhat') as HardhatRuntimeEnvironment;
  runDeploy(hre, process.env, consoleIo).catch((error: Error) => {
    consoleIo.error('');
    consoleIo.error(error.message);
    process.exitCode = 1;
  });
}
