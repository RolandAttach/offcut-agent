import { ZeroAddress, getAddress } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';

import { consoleIo, field, heading, type Io } from './lib/io';
import { requireAddress, type Env } from './lib/env';
import {
  explorerAddressUrl,
  explorerTxUrl,
  isDryRun,
  requireMainnetConfirmation,
  resolveNetwork,
  type NetworkOverrides,
} from './lib/network';
import {
  deploymentsDir,
  recordPath,
  requireRecord,
  updateRecord,
  type DeploymentRecord,
} from './lib/deployments';
import { attachRewards } from './lib/rewards';
import { ethersOf } from './lib/hre';

/**
 * Names the OFFCUT token on a deployed rewards contract. Owner only, once ever.
 *
 * This is the last step of the launch and the only one in this directory that
 * cannot be repeated: setToken reverts TokenAlreadySet the second time, because
 * changing the token after anyone has claimed would make `claimed` a number
 * standing for amounts of two different assets. So every check here is about
 * one thing - that the address being written is the address that was meant.
 *
 * The checksum is compared rather than parsed (see lib/env.ts), the address is
 * required to have code, the contract is read back afterwards, and the record
 * on disk is only updated once the chain agrees. A token address typed one
 * character wrong and accepted here is a rewards contract that pays out the
 * wrong asset forever, on a contract that cannot be pointed anywhere else.
 */

export interface SetTokenOptions extends NetworkOverrides {
  deploymentsDir?: string;
}

export interface SetTokenResult {
  token: string;
  txHash: string | null;
  record: DeploymentRecord;
  dryRun: boolean;
}

export async function runSetToken(
  hre: HardhatRuntimeEnvironment,
  env: Env,
  io: Io,
  options: SetTokenOptions = {}
): Promise<SetTokenResult> {
  const net = await resolveNetwork(hre, options);
  const dir = deploymentsDir(env, options.deploymentsDir);
  const path = recordPath(dir, net.name);
  const record = requireRecord(path);

  heading(io, `OFFCUT rewards - set token on ${net.name}`);

  if (record.chainId !== Number(net.chainId)) {
    throw new Error(
      `${path} records chain ${record.chainId}, but this network answers ${net.chainId}. ` +
        'Refusing: that record belongs to a different chain.'
    );
  }

  const token = requireAddress(env, 'OFFCUT_TOKEN_ADDRESS');

  // A rewards contract paying out an address with no code pays out nothing, and
  // the mistake is unrecoverable. One eth_getCode is cheap insurance.
  const eth = ethersOf(hre);
  const tokenCode = await eth.provider.getCode(token);
  if (tokenCode === '0x') {
    throw new Error(
      `There is no contract at ${token} on ${net.name}.\n` +
        '  Refusing: setToken is one-shot, and an address with no code is not a token.'
    );
  }

  const proxyCode = await eth.provider.getCode(record.proxy);
  if (proxyCode === '0x') {
    throw new Error(
      `There is no contract at the recorded proxy ${record.proxy} on ${net.name}. ` +
        'Refusing: the record does not describe this chain.'
    );
  }

  const rewards = await attachRewards(hre, record.proxy);
  const current = getAddress(await rewards.token());
  if (current !== ZeroAddress) {
    throw new Error(
      `token() is already set to ${current}.\n` +
        '  Refusing: setToken is one-shot and the contract would revert TokenAlreadySet.\n' +
        '  If that address is wrong, the fix is an upgrade, not this script.'
    );
  }

  const signers = await eth.getSigners();
  const caller = signers[0];
  if (!caller) {
    throw new Error(
      `Network "${net.name}" has no account configured. Set OFFCUT_DEPLOYER_KEY (the OWNER key ` +
        'for this call) and run again.'
    );
  }

  const onChainOwner = getAddress(await rewards.owner());
  if (getAddress(caller.address) !== onChainOwner) {
    throw new Error(
      'setToken is owner-only and the configured key is not the owner.\n' +
        `  owner  ${onChainOwner}\n` +
        `  caller ${getAddress(caller.address)}\n` +
        '  Refusing before sending: the call would revert and cost gas for nothing.'
    );
  }

  heading(io, 'Preflight');
  field(io, 'network', `${net.name}${net.live ? '' : '  (in-process, not a live chain)'}`);
  field(io, 'chain id', String(net.chainId));
  field(io, 'proxy', record.proxy);
  field(io, 'owner / caller', onChainOwner);
  field(io, 'token to set', token);
  const tokenLink = explorerAddressUrl(net, token);
  if (tokenLink) field(io, 'token on explorer', tokenLink);
  field(io, 'record', path);

  requireMainnetConfirmation(env, net);

  if (isDryRun(env)) {
    io.log('');
    io.log('  OFFCUT_DEPLOY_DRY_RUN=1 - preflight only. Nothing was sent.');
    return { token, txHash: null, record, dryRun: true };
  }

  heading(io, 'Sending setToken');
  const tx = await rewards.setToken(token);
  io.log(`  tx ${tx.hash}`);
  await tx.wait(net.live ? 2 : 1);

  const readBack = getAddress(await rewards.token());
  if (readBack !== token) {
    throw new Error(
      `token() read back as ${readBack}, not ${token}. The record has NOT been updated. ` +
        'Check the transaction on the explorer before doing anything else.'
    );
  }

  const updated = updateRecord(path, {
    token: readBack,
    tokenSetAt: new Date().toISOString(),
    tokenTxHash: tx.hash,
  });

  heading(io, 'Token set');
  field(io, 'token()', readBack);
  field(io, 'tx', tx.hash);
  const txLink = explorerTxUrl(net, tx.hash);
  if (txLink) field(io, 'explorer', txLink);
  field(io, 'record', path);
  io.log('');
  io.log('  Claims are live from this block, for anyone with a proof against the current root.');
  io.log('  Run status next.');

  return { token: readBack, txHash: tx.hash, record: updated, dryRun: false };
}

if (require.main === module) {
  const hre = require('hardhat') as HardhatRuntimeEnvironment;
  runSetToken(hre, process.env, consoleIo).catch((error: Error) => {
    consoleIo.error('');
    consoleIo.error(error.message);
    process.exitCode = 1;
  });
}
