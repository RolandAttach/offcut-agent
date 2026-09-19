import '@nomicfoundation/hardhat-toolbox';
import '@openzeppelin/hardhat-upgrades';
import type { HardhatUserConfig } from 'hardhat/config';

/**
 * Contract tooling for Robinhood Chain.
 *
 * Both networks are declared, but neither carries a private key: deployment
 * keys are supplied at the moment of deployment through the environment and
 * never live in this repository. `OFFCUT_DEPLOYER_KEY` is read only if it is
 * set, so a checkout with no key configured still compiles and tests.
 *
 * Testing runs against the in-process Hardhat network by default. That catches
 * logic, not chain behaviour — Arbitrum Orbit accounts for gas differently and
 * has its own view of block numbers — so a deployment to the live chain is a
 * first run, not a repeat of the tests.
 */

/**
 * The deployer key reaches hardhat one of two ways: inline in
 * OFFCUT_DEPLOYER_KEY, or as a FILE named in OFFCUT_DEPLOYER_KEY_FILE — the
 * file `pnpm keys` writes (generate-keys.js), or a bare hex key. The file form
 * exists so the key never has to pass through a shell command line, a
 * transcript or a clipboard: the process reads it itself. The first
 * 0x + 64 hex token in the file is the key; nothing from the file is logged.
 */
function readDeployerKey(): string | undefined {
  const inline = process.env.OFFCUT_DEPLOYER_KEY?.trim();
  const file = process.env.OFFCUT_DEPLOYER_KEY_FILE?.trim();
  if (inline && file) {
    throw new Error('Both OFFCUT_DEPLOYER_KEY and OFFCUT_DEPLOYER_KEY_FILE are set. Unset one.');
  }
  if (inline) return inline;
  if (!file) return undefined;
  let material: string;
  try {
    material = require('node:fs').readFileSync(file, 'utf8') as string;
  } catch {
    throw new Error(`OFFCUT_DEPLOYER_KEY_FILE="${file}" could not be read.`);
  }
  const match = material.match(/0x[0-9a-fA-F]{64}/);
  if (!match) throw new Error(`OFFCUT_DEPLOYER_KEY_FILE="${file}" holds no private key.`);
  return match[0];
}

const deployerKey = readDeployerKey();
const accounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      // The distributor is called far more often than it is deployed, so the
      // optimiser is tuned for runtime cost rather than deployment size.
      optimizer: { enabled: true, runs: 1000 },
    },
  },

  networks: {
    hardhat: {
      // Mirrors the chain the contracts will actually live on, so anything that
      // reads block.chainid behaves in tests the way it will in production.
      chainId: 4663,
    },
    robinhood: {
      url: 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts,
    },
    robinhoodTestnet: {
      url: 'https://rpc.testnet.chain.robinhood.com',
      chainId: 46630,
      accounts,
    },
  },

  /**
   * Mocha's reporter, and why it is not simply 'spec'.
   *
   * The /proof page names the file every test lives in, and mocha's console
   * output carries no such list — only a total at the end, which is how the
   * contracts suite came to be cited on that page by a count of `it(` lines
   * in the source rather than by a count of results. apps/web/scripts/proof.mjs
   * now sets these two variables and reads mocha's own JSON report instead.
   * Unset, which is every ordinary `pnpm test`, this is the default reporter
   * and nothing about a local run changes.
   */
  mocha: {
    reporter: process.env.OFFCUT_MOCHA_REPORTER || 'spec',
    reporterOptions: process.env.OFFCUT_MOCHA_REPORT_FILE
      ? { output: process.env.OFFCUT_MOCHA_REPORT_FILE }
      : undefined,
  },

  // Blockscout's own API sits behind a Cloudflare challenge that refuses
  // non-browser clients, so verification goes through Sourcify (which lists
  // Robinhood Chain 4663) and Blockscout reads the match from there.
  sourcify: { enabled: true },
  etherscan: {
    // Blockscout verifies through an Etherscan-compatible endpoint and ignores
    // the key, but the field must be present for the plugin to attempt it.
    apiKey: { robinhood: 'blockscout' },
    customChains: [
      {
        network: 'robinhood',
        chainId: 4663,
        urls: {
          apiURL: 'https://robinhoodchain.blockscout.com/api',
          browserURL: 'https://robinhoodchain.blockscout.com',
        },
      },
    ],
  },
};

export default config;
