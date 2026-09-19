import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Env } from './env';

/**
 * deployments/<network>.json — the addresses, written down once.
 *
 * After launch day the proxy address is needed in four places that have no way
 * of asking the chain: the server's publisher env, the web build's
 * NEXT_PUBLIC_OFFCUT_REWARDS_ADDRESS, `set-token`, and every later `status`.
 * Copying it by hand from a terminal that has scrolled away is how the wrong
 * address ends up in one of the four. So the deploy writes it, and everything
 * afterwards reads it rather than being told.
 *
 * The file existing is also the guard against deploying twice — see deploy.ts.
 * That is why nothing here overwrites blindly: `write` refuses over an existing
 * record and `update` requires one.
 */
export interface DeploymentExplorerLinks {
  proxy: string | null;
  implementation: string | null;
  deployTx: string | null;
}

export interface DeploymentRecord {
  network: string;
  chainId: number;
  proxy: string;
  implementation: string;
  owner: string;
  publisher: string;
  /** null until the OFFCUT token exists and `set-token` has been run. */
  token: string | null;
  tokenSetAt?: string;
  tokenTxHash?: string;
  deployer: string;
  txHash: string;
  blockNumber: number;
  deployedAt: string;
  explorer: DeploymentExplorerLinks;
}

/**
 * Tests point this at a temp directory so a run never touches the real records;
 * OFFCUT_DEPLOYMENTS_DIR does the same for a rehearsal on someone's machine.
 */
export function deploymentsDir(env: Env, override?: string): string {
  if (override) return resolve(override);
  const fromEnv = env.OFFCUT_DEPLOYMENTS_DIR;
  if (fromEnv && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return resolve(__dirname, '..', '..', 'deployments');
}

export function recordPath(dir: string, networkName: string): string {
  return join(dir, `${networkName}.json`);
}

export function readRecord(path: string): DeploymentRecord | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as DeploymentRecord;
  } catch (error) {
    throw new Error(`${path} exists but is not readable JSON: ${(error as Error).message}`);
  }
}

export function requireRecord(path: string): DeploymentRecord {
  const record = readRecord(path);
  if (!record) {
    throw new Error(
      `No deployment record at ${path}.\n` +
        '  Deploy first (hardhat run scripts/deploy.ts --network <net>), or point\n' +
        '  OFFCUT_DEPLOYMENTS_DIR at the directory that holds it.'
    );
  }
  return record;
}

export function writeRecord(path: string, record: DeploymentRecord): void {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite an existing deployment record at ${path}.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** For set-token, which adds to a record rather than creating one. */
export function updateRecord(path: string, patch: Partial<DeploymentRecord>): DeploymentRecord {
  const record = requireRecord(path);
  const next = { ...record, ...patch };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
