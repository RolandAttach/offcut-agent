import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { flag, type Env } from './env';
import { ethersOf } from './hre';

/**
 * Which chain are we actually talking to, and is it the one holding money.
 *
 * hardhat.config.ts declares a chainId per network, but a declaration is not a
 * fact: an rpc url can be repointed, a provider can fail over to a fork, and a
 * testnet endpoint can quietly answer for mainnet. So every script asks the
 * node itself for eth_chainId and refuses if the answer is not what the config
 * promised. It costs one round trip and it is the difference between deploying
 * to the testnet and deploying to the chain with the owner's ETH on it.
 *
 * "Live" is a separate question from the chain id, and the reason is the local
 * network: the in-process Hardhat network is configured with chainId 4663 on
 * purpose, so that anything reading block.chainid behaves in tests the way it
 * will in production. That makes the chain id alone useless for deciding
 * whether a run needs the mainnet confirmation. A network is live when it has
 * an rpc url — an in-process EVM does not — and only a live 4663 is mainnet.
 */
export const MAINNET_CHAIN_ID = 4663n;
export const TESTNET_CHAIN_ID = 46630n;

/** The variable a mainnet run must carry, quoted verbatim in the refusal. */
export const MAINNET_CONFIRM_VAR = 'OFFCUT_DEPLOY_CONFIRM';
export const MAINNET_CONFIRM_VALUE = 'mainnet';

export interface NetworkOverrides {
  /** Tests name the network they are pretending to be on. */
  networkName?: string;
  /** Tests simulate a live chain without one; nothing else sets this. */
  live?: boolean;
}

export interface ResolvedNetwork {
  name: string;
  live: boolean;
  chainId: bigint;
  configuredChainId: number;
  mainnet: boolean;
  explorer: string | null;
}

/**
 * Blockscout is declared for mainnet only.
 *
 * apps/web/src/lib/chains.ts says why the testnet has none: the public explorer
 * for 46630 was never verified, and a link that 404s on launch day is worse
 * than no link. The deployment record repeats that choice as `null` rather than
 * guessing a hostname.
 */
export function explorerFor(chainId: bigint): string | null {
  return chainId === MAINNET_CHAIN_ID ? 'https://robinhoodchain.blockscout.com' : null;
}

/**
 * Links are built from the resolved network rather than the chain id alone, so
 * a local rehearsal never writes a mainnet explorer link into its record: the
 * in-process network answers 4663 too, and a record whose links point at a
 * contract on the real chain is a trap for whoever reads it next.
 */
export function explorerAddressUrl(net: ResolvedNetwork, address: string): string | null {
  return net.explorer ? `${net.explorer}/address/${address}` : null;
}

export function explorerTxUrl(net: ResolvedNetwork, hash: string): string | null {
  return net.explorer ? `${net.explorer}/tx/${hash}` : null;
}

export async function resolveNetwork(
  hre: HardhatRuntimeEnvironment,
  overrides: NetworkOverrides = {}
): Promise<ResolvedNetwork> {
  const name = overrides.networkName ?? hre.network.name;

  const configuredChainId = hre.network.config.chainId;
  if (configuredChainId === undefined) {
    throw new Error(
      `Network "${name}" declares no chainId in hardhat.config.ts. Add one: without it there is ` +
        'nothing to check the node\'s answer against.'
    );
  }

  const live =
    overrides.live ??
    (typeof (hre.network.config as { url?: unknown }).url === 'string');

  const { chainId } = await ethersOf(hre).provider.getNetwork();
  if (chainId !== BigInt(configuredChainId)) {
    throw new Error(
      `Chain id mismatch on network "${name}".\n` +
        `  hardhat.config.ts says ${configuredChainId}\n` +
        `  eth_chainId answered  ${chainId}\n` +
        '  Refusing: the endpoint is not the chain this network is configured for.'
    );
  }

  return {
    name,
    live,
    chainId,
    configuredChainId,
    mainnet: live && chainId === MAINNET_CHAIN_ID,
    explorer: live ? explorerFor(chainId) : null,
  };
}

/**
 * The one deliberate speed bump.
 *
 * Everything else in these scripts refuses because something is wrong. This
 * refuses because nothing is wrong and the run is about to spend real money on
 * a contract that cannot be deployed twice.
 */
export function requireMainnetConfirmation(env: Env, net: ResolvedNetwork): void {
  if (!net.mainnet) return;
  if (env[MAINNET_CONFIRM_VAR] === MAINNET_CONFIRM_VALUE) return;

  throw new Error(
    `This is Robinhood Chain MAINNET (chain id ${net.chainId}) and the run is not confirmed.\n` +
      `  Set ${MAINNET_CONFIRM_VAR}=${MAINNET_CONFIRM_VALUE} and run again.\n` +
      '  Nothing has been sent.'
  );
}

/** `OFFCUT_DEPLOY_DRY_RUN=1` — preflight, then stop, on any network. */
export function isDryRun(env: Env): boolean {
  return flag(env, 'OFFCUT_DEPLOY_DRY_RUN');
}
