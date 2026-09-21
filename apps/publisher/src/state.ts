/**
 * The cursor: the last period whose accrual was written down.
 *
 * One small JSON file, replaced atomically. It answers one question - where to
 * resume - and deliberately does not try to answer the harder one.
 *
 * ---------------------------------------------------------------------------
 * Why this file is not what stops a period being paid twice
 * ---------------------------------------------------------------------------
 *
 * Recording a period and recording that it was recorded are two writes to two
 * different stores, so there is always an instant between them where the
 * process can die. No ordering fixes that: cursor first loses the period,
 * ledger first repeats it. A file cannot be the guarantee.
 *
 * The ledger is. recordAccruals in @offcut/rewards keys a row on
 * (address, periodStart) and refuses any window that overlaps one already on
 * file, so re-running a period writes nothing new, and re-running it with
 * DIFFERENT figures throws instead of quietly disagreeing with the roots
 * already published. That makes replay safe, which in turn makes this file's
 * job small: it exists so a restart does not have to re-derive every period
 * since the beginning of time, and so a period is never jumped over.
 *
 * So the rule here is one-directional. The cursor is written only after the
 * ledger has accepted the period, and anything after it is replayed. Losing
 * this file entirely costs correctness nothing; it costs a cold start, which is
 * why the corrupt case below refuses rather than pretending to be one.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PublisherState {
  /** Highest period index whose accrual is in the ledger. Later periods are owed. */
  lastCompletedPeriod: number;
  /**
   * The last root this service saw on chain, and when it saw it.
   *
   * Only a saving, never a source of truth: while the cumulative root has not
   * moved, the chain would answer exactly this, so a tick with nothing new to
   * say does not ask. That is most ticks on a quiet product, and asking anyway
   * is what made the public endpoint refuse about half of them - two reads
   * every ten minutes, forever, for an answer that had not changed since the
   * last publication. It is re-checked when the root moves and once every few
   * hours regardless, so a chain that moved without us is noticed.
   */
  confirmed?: { root: string; index: number; at: number };
}

export interface StateStore {
  read(): PublisherState | null;
  write(state: PublisherState): void;
}

const FORMAT = 1;

/**
 * State on disk, replaced atomically.
 *
 * Written to a sibling temp file, flushed, then renamed over the target: a
 * rename is the one filesystem operation that cannot leave half a cursor
 * behind, and half a cursor reads as no cursor, which is a cold start in the
 * middle of a running deployment.
 */
export function fileStateStore(file: string): StateStore {
  return {
    read(): PublisherState | null {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }

      let parsed: Partial<PublisherState> = {};
      let readable = true;
      try {
        parsed = JSON.parse(raw) as Partial<PublisherState>;
      } catch {
        readable = false;
      }

      // A cursor we cannot read is not the same as no cursor. Treating it as
      // one would jump the service forward to now and silently never pay
      // whatever sat between, so it is refused and a person decides.
      if (!readable || !Number.isInteger(parsed.lastCompletedPeriod)) {
        throw new Error(
          `${file} is not a publisher cursor this version understands. Fix it or delete it before ` +
            'starting. Deleting it makes the next start a cold start, which settles only the period ' +
            'that has just closed and never the ones before it.'
        );
      }

      const confirmed = parsed.confirmed;
      const usable =
        confirmed &&
        typeof confirmed.root === 'string' &&
        Number.isInteger(confirmed.index) &&
        Number.isFinite(confirmed.at);

      return {
        lastCompletedPeriod: parsed.lastCompletedPeriod as number,
        // A half-written or older-format note is simply absent: the only cost
        // of not having it is one read of the chain.
        ...(usable ? { confirmed: { ...(confirmed as PublisherState['confirmed'] & object) } } : {}),
      };
    },

    write(state: PublisherState): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });

      const temp = `${file}.tmp`;
      const handle = fs.openSync(temp, 'w');
      try {
        fs.writeFileSync(handle, `${JSON.stringify({ format: FORMAT, ...state }, null, 2)}\n`);
        // Without this the rename can land before the bytes do, and a machine
        // that loses power comes back to a cursor pointing at content that was
        // never written.
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }

      fs.renameSync(temp, file);
    },
  };
}

/** In-memory cursor. Tests drive restarts with it; nothing else uses it. */
export function memoryStateStore(initial: PublisherState | null = null): StateStore {
  let current = initial;
  return {
    read: () => (current ? { ...current } : null),
    write: (state) => {
      current = { ...state };
    },
  };
}
