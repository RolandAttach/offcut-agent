import { ZeroAddress, ZeroHash, formatEther, formatUnits, getAddress } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';

import { consoleIo, field, heading, type Io } from './lib/io';
import { optionalAddress, type Env } from './lib/env';
import { explorerAddressUrl, resolveNetwork, type NetworkOverrides } from './lib/network';
import { deploymentsDir, readRecord, recordPath } from './lib/deployments';
import { ERC20_READ_ABI, attachRewards, type Erc20Readonly } from './lib/rewards';
import { ethersOf } from './lib/hre';

/**
 * What the rewards contract says about itself, right now. Reads only.
 *
 * This is the thing to run before and after every other step on launch day:
 * before, to see the state you are about to change; after, to see that it
 * changed the way the other script claimed. Nothing here sends a transaction,
 * so it is safe to run against mainnet at any time, and it needs no key - a
 * network with no account configured still prints everything below.
 *
 * The two ETH balances at the end are the ones that stop the day: the deployer
 * pays for the deploy and the upgrades, the publisher pays for a root every ten
 * minutes forever. A publisher at zero is a distribution that silently stops
 * updating, which is why the number is printed next to the addresses rather
 * than left to a block explorer somebody has to remember to open.
 */

export interface StatusOptions extends NetworkOverrides {
  deploymentsDir?: string;
}

export interface StatusSummary {
  network: string;
  chainId: number;
  proxy: string;
  implementation: string | null;
  owner: string;
  pendingOwner: string | null;
  publisher: string;
  token: string | null;
  paused: boolean;
  rootIndex: bigint;
  merkleRoot: string;
  rootPublishedAt: bigint;
  totalClaimed: bigint;
  proxyTokenBalance: bigint | null;
  balances: Record<string, bigint>;
}

export async function runStatus(
  hre: HardhatRuntimeEnvironment,
  env: Env,
  io: Io,
  options: StatusOptions = {}
): Promise<StatusSummary> {
  const net = await resolveNetwork(hre, options);
  const dir = deploymentsDir(env, options.deploymentsDir);
  const path = recordPath(dir, net.name);
  const record = readRecord(path);

  // The record is the normal source of the address; the override exists so the
  // orchestrator can point status at a contract before the record has been
  // copied to whatever machine they are standing at.
  const override = optionalAddress(env, 'OFFCUT_CONTRACT_ADDRESS');
  const proxyAddress = override ?? record?.proxy;
  if (!proxyAddress) {
    throw new Error(
      `No deployment record at ${path} and no OFFCUT_CONTRACT_ADDRESS set. Nothing to report on.`
    );
  }

  heading(io, `OFFCUT rewards - status on ${net.name}`);
  field(io, 'network', `${net.name}${net.live ? '' : '  (in-process, not a live chain)'}`);
  field(io, 'chain id', String(net.chainId));
  field(io, 'proxy', getAddress(proxyAddress));
  field(io, 'address from', override ? 'OFFCUT_CONTRACT_ADDRESS' : path);

  const eth = ethersOf(hre);
  const code = await eth.provider.getCode(proxyAddress);
  if (code === '0x') {
    throw new Error(`There is no contract at ${getAddress(proxyAddress)} on ${net.name}.`);
  }

  let implementation: string | null = null;
  try {
    implementation = getAddress(
      await hre.upgrades.erc1967.getImplementationAddress(getAddress(proxyAddress))
    );
  } catch {
    // A non-proxy, or a node that will not serve the storage slot. Not fatal:
    // everything below still reads through the proxy's own ABI.
    implementation = null;
  }

  const rewards = await attachRewards(hre, proxyAddress);
  const owner = getAddress(await rewards.owner());
  const publisher = getAddress(await rewards.publisher());
  const tokenAddress = getAddress(await rewards.token());
  const paused = await rewards.paused();
  const rootIndex = await rewards.rootIndex();
  const merkleRoot = await rewards.merkleRoot();
  const rootPublishedAt = await rewards.rootPublishedAt();
  const totalClaimed = await rewards.totalClaimed();

  let pendingOwner: string | null = null;
  try {
    const pending = getAddress(await rewards.pendingOwner());
    pendingOwner = pending === ZeroAddress ? null : pending;
  } catch {
    pendingOwner = null;
  }

  heading(io, 'Contract');
  if (implementation) field(io, 'implementation', implementation);
  field(io, 'owner()', owner);
  if (pendingOwner) {
    field(io, 'pendingOwner()', `${pendingOwner}  (transfer started, not accepted)`);
  }
  field(io, 'publisher()', publisher);
  field(
    io,
    'token()',
    tokenAddress === ZeroAddress ? `${ZeroAddress}  (not set - claim() reverts TokenNotSet)` : tokenAddress
  );
  field(io, 'paused()', String(paused));

  heading(io, 'Roots');
  field(io, 'rootIndex()', String(rootIndex));
  field(
    io,
    'merkleRoot()',
    merkleRoot === ZeroHash ? `${ZeroHash}  (nothing published yet)` : merkleRoot
  );
  field(
    io,
    'rootPublishedAt()',
    rootPublishedAt === 0n
      ? '0  (never)'
      : `${rootPublishedAt}  (${new Date(Number(rootPublishedAt) * 1000).toISOString()})`
  );
  field(io, 'totalClaimed()', `${formatEther(totalClaimed)} (18dp assumed for display)`);

  // -- the pool -------------------------------------------------------------
  let proxyTokenBalance: bigint | null = null;
  if (tokenAddress !== ZeroAddress) {
    heading(io, 'Reward pool');
    try {
      const erc20 = new eth.Contract(
        tokenAddress,
        ERC20_READ_ABI,
        eth.provider
      ) as unknown as Erc20Readonly;
      const balance = await erc20.balanceOf(proxyAddress);
      proxyTokenBalance = balance;
      let decimals = 18;
      let symbol = 'OFFCUT';
      try {
        decimals = Number(await erc20.decimals());
        symbol = String(await erc20.symbol());
      } catch {
        // A token that will not answer decimals()/symbol() still has a balance
        // worth printing; say what was assumed rather than failing the report.
        io.warn('  token decimals()/symbol() did not answer; showing 18dp as "OFFCUT".');
      }
      field(io, 'proxy balance', `${formatUnits(balance, decimals)} ${symbol}`);
      field(io, 'unclaimed cover', balance === 0n ? 'EMPTY - claims will revert' : 'funded');
    } catch (error) {
      io.warn(`  Could not read the token balance: ${(error as Error).message}`);
    }
  }

  // -- ETH ------------------------------------------------------------------
  heading(io, 'ETH balances (gas)');
  const wallets: Record<string, string> = { owner, publisher };
  if (record?.deployer) wallets.deployer = getAddress(record.deployer);

  const balances: Record<string, bigint> = {};
  for (const [label, address] of Object.entries(wallets)) {
    const wei = await eth.provider.getBalance(address);
    balances[label] = wei;
    field(io, label, `${formatEther(wei)} ETH   ${address}`);
  }
  if (balances.publisher === 0n) {
    io.warn('  publisher has no ETH - publishRoot will fail and the distribution will stall.');
  }

  const link = explorerAddressUrl(net, proxyAddress);
  if (link) {
    io.log('');
    field(io, 'explorer', link);
  }

  return {
    network: net.name,
    chainId: Number(net.chainId),
    proxy: getAddress(proxyAddress),
    implementation,
    owner,
    pendingOwner,
    publisher,
    token: tokenAddress === ZeroAddress ? null : tokenAddress,
    paused,
    rootIndex,
    merkleRoot,
    rootPublishedAt,
    totalClaimed,
    proxyTokenBalance,
    balances,
  };
}

if (require.main === module) {
  const hre = require('hardhat') as HardhatRuntimeEnvironment;
  runStatus(hre, process.env, consoleIo).catch((error: Error) => {
    consoleIo.error('');
    consoleIo.error(error.message);
    process.exitCode = 1;
  });
}
