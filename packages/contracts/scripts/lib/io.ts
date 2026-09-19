/**
 * Where a script's words go.
 *
 * Every script in this directory is run twice: once by a person on launch day,
 * with the output on their terminal and a real chain on the other end, and once
 * by the test suite, which has to read what was printed to know the script did
 * what it said. Handing the core functions an `Io` rather than letting them
 * reach for `console` is what makes the second run possible — and it keeps the
 * refusal messages, which are the point of these scripts, under test.
 */
export interface Io {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export const consoleIo: Io = {
  log: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

export interface CapturedIo extends Io {
  /** Every line, in order, whatever channel it went to. */
  readonly lines: string[];
  /** The lines joined, for a plain `expect(...).to.include(...)`. */
  text(): string;
}

/** An `Io` that remembers instead of printing. Tests only. */
export function captureIo(): CapturedIo {
  const lines: string[] = [];
  return {
    lines,
    text: () => lines.join('\n'),
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
}

/** A blank line and a rule, so a long preflight reads as sections. */
export function heading(io: Io, title: string): void {
  io.log('');
  io.log(title);
  io.log('-'.repeat(title.length));
}

/** `label ......... value`, so a column of numbers lines up on a terminal. */
export function field(io: Io, label: string, value: string): void {
  io.log(`  ${label.padEnd(24, ' ')} ${value}`);
}
