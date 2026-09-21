/**
 * Proof files: the half of a claim that does not fit on a chain.
 *
 * A root is 32 bytes; the proofs that make it useful are a few hundred bytes
 * per recipient, and they have to be somewhere the console can hand to a wallet
 * at the moment somebody clicks Claim. That is deliberately a static file and
 * not an endpoint over the database:
 *
 *   - a claim must still work when the API is down, and it can, because the
 *     contract does not care where the proof came from
 *   - the proofs for a root never change, so anything that can serve a file can
 *     serve them
 *   - nobody needs an account to read them; a proof is only useful to the
 *     address named inside it, and the amounts are verifiable against the root
 *     by anyone anyway
 *
 * One file per root index rather than one file overwritten in place, because a
 * page loaded ten minutes ago is holding a proof against an older root and the
 * contract still accepts it - roots are cumulative, so the old proof pays the
 * old amount rather than failing. Deleting the old file would turn a working
 * claim into a 404 for no gain; they are small.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RewardTree } from '@offcut/rewards';

const FORMAT = 1;

export interface ProofClaim {
  /** Exactly the string that went into the leaf. */
  address: string;
  /** Decimal, in base units. Never a number: these exceed what a double holds. */
  cumulativeAmount: string;
  proof: string[];
}

export interface ProofDocument {
  format: number;
  rootIndex: number;
  root: string;
  publishedAt: string;
  chainId: number;
  contract: string;
  addresses: number;
  /** Sum of every cumulative amount in this root. */
  totalCumulative: string;
  /** Present only when no transaction was sent. Keeps a rehearsal from reading as real. */
  dryRun?: true;
  /** Keyed by lowercase address, because that is what a wallet hands the page. */
  claims: Record<string, ProofClaim>;
}

export interface ProofMeta {
  rootIndex: number;
  chainId: number;
  contract: string;
  publishedAt: Date;
  dryRun: boolean;
}

export function buildProofDocument(tree: RewardTree, meta: ProofMeta): ProofDocument {
  const claims: Record<string, ProofClaim> = {};
  let total = 0n;

  for (const entry of tree.entries) {
    const key = entry.account.toLowerCase();
    claims[key] = {
      address: entry.account,
      cumulativeAmount: entry.cumulativeAmount.toString(),
      // Taken from the tree rather than recomputed. A proof built a second time
      // by different code is a second chance to disagree with the root.
      proof: tree.proofs[key] ?? [],
    };
    total += entry.cumulativeAmount;
  }

  const document: ProofDocument = {
    format: FORMAT,
    rootIndex: meta.rootIndex,
    root: tree.root,
    publishedAt: meta.publishedAt.toISOString(),
    chainId: meta.chainId,
    contract: meta.contract,
    addresses: tree.entries.length,
    totalCumulative: total.toString(),
    claims,
  };

  if (meta.dryRun) document.dryRun = true;
  return document;
}

export interface ProofWriter {
  /** The root the `latest` pointer names, or null if nothing has been written. */
  latestRoot(): string | null;
  write(document: ProofDocument): void;
}

function writeAtomic(file: string, contents: string): void {
  const temp = `${file}.tmp`;
  const handle = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(handle, contents);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
}

export function fileProofWriter(dir: string): ProofWriter {
  const latest = path.join(dir, 'latest.json');

  return {
    latestRoot(): string | null {
      try {
        const parsed = JSON.parse(fs.readFileSync(latest, 'utf8')) as Partial<ProofDocument>;
        return typeof parsed.root === 'string' ? parsed.root : null;
      } catch {
        // No file, or one we cannot read. Either way we do not know what was
        // last written, and the caller's answer to that is to write it again -
        // which is harmless, because the content is derived, not accumulated.
        return null;
      }
    },

    write(document: ProofDocument): void {
      fs.mkdirSync(dir, { recursive: true });

      const body = `${JSON.stringify(document, null, 2)}\n`;

      // Numbered file first. If the process dies between the two writes, the
      // pointer still names the previous root and every proof it names is still
      // on disk; a pointer written first would name a file that does not exist.
      writeAtomic(path.join(dir, `root-${document.rootIndex}.json`), body);
      writeAtomic(latest, body);
    },
  };
}

/** Collects documents in memory. Tests read them back; nothing else uses it. */
export function memoryProofWriter(): ProofWriter & { documents: ProofDocument[] } {
  const documents: ProofDocument[] = [];
  return {
    documents,
    latestRoot: () => documents[documents.length - 1]?.root ?? null,
    write: (document) => {
      documents.push(document);
    },
  };
}
