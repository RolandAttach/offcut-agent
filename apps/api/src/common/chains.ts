/**
 * The two networks a Sign-In-With-Ethereum message may name.
 *
 * Copied from apps/web/src/lib/chains.ts, where both endpoints were checked
 * against a live eth_chainId rather than taken from documentation - 0x1237
 * (4663) on mainnet, 0xb626 (46630) on the testnet. Duplicated rather than
 * imported for the same reason apps/publisher keeps its own copy: a server must
 * not depend on a Next app to know what network it is on, and two URLs are
 * cheaper than that coupling.
 *
 * Nothing here signs or sends a transaction. The chain is consulted for exactly
 * one read - "is this signature valid for this address" - which is how a smart
 * account can sign in at all (ERC-1271), and line 19 of the specification rules
 * out the other kind of request entirely.
 */

import { defineChain } from 'viem';

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  testnet: true,
});

/**
 * Which network this server accepts a sign-in from.
 *
 * OFFCUT_NETWORK, spelled exactly as apps/publisher spells it, so one variable
 * moves the whole backend at once. Read at import time: a message naming the
 * other network is refused rather than quietly verified against it, which is
 * what stops a signature gathered on the testnet from opening a mainnet
 * account.
 */
export const activeChain =
  process.env.OFFCUT_NETWORK?.trim() === 'testnet' ? robinhoodTestnet : robinhoodChain;

/** Every chain id a message may claim. Anything else is not this product. */
export const ACCEPTED_CHAIN_IDS: readonly number[] = [robinhoodChain.id, robinhoodTestnet.id];
