import type { BaseContract, Contract, ContractFactory, Provider, TransactionRequest } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';

/**
 * hre.ethers, typed.
 *
 * `@nomicfoundation/hardhat-ethers` reaches this package as a transitive
 * dependency of hardhat-toolbox, and under pnpm's strict layout TypeScript
 * cannot resolve its declarations from here: the plugin's augmentation of
 * `hre.ethers` never loads, so `hre.ethers` types as the bare ethers module and
 * every helper on it - getSigners, provider, getContractFactory - is reported
 * as a missing property. That is a resolution failure, not a runtime one; the
 * plugin is loaded and working, which is why the existing suite runs green
 * while `tsc --noEmit` on this package has always been red (test/OffcutRewards
 * .test.ts carries the same errors, plus mocha's globals).
 *
 * Fixing the resolution means adding dependencies and touching the workspace
 * lockfile, which is outside this package. So the scripts declare the slice of
 * the plugin they actually use and go through this accessor. The declaration
 * below is the contract these scripts rely on; if the plugin ever changes
 * shape, the failure is a runtime error on the first call rather than a silent
 * wrong value.
 */
export interface HardhatSigner {
  address: string;
}

export interface HardhatEthers {
  provider: Provider;
  getSigners(): Promise<HardhatSigner[]>;
  getContractFactory(name: string): Promise<ContractFactory>;
  getContractAt(name: string, address: string): Promise<BaseContract>;
  Contract: typeof Contract;
}

export function ethersOf(hre: HardhatRuntimeEnvironment): HardhatEthers {
  return hre.ethers as unknown as HardhatEthers;
}

/** The gas-estimation shape, so the deploy preflight is not `any`. */
export type DeployEstimateRequest = TransactionRequest;
