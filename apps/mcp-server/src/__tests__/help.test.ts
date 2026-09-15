/**
 * The two commands, held to the letter.
 *
 * They are the answer to the only question a stranger has at this point -
 * "which of these do I paste?" - and the console prints the same two. If one
 * of them drifts here, somebody follows instructions that do not work, which
 * is the exact fault this release was opened to fix.
 *
 * Read from the source rather than imported: index.ts starts a server when it
 * is loaded, and a test that spawned one to read a help string would be paying
 * a process for a string.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src', 'index.ts'), 'utf8');

describe('--help', () => {
  it('prints the remote command exactly', () => {
    expect(source).toContain(
      'claude mcp add offcut -e OFFCUT_API_URL=https://offcut.tech -e OFFCUT_API_KEY=offcut_sk_... -- npx -y @offcut/mcp-server'
    );
  });

  it('prints the local command exactly', () => {
    expect(source).toContain(
      'claude mcp add offcut -e OFFCUT_API_KEY=offcut_sk_... -- npx -y @offcut/mcp-server'
    );
  });

  it('says which store each one uses', () => {
    expect(source).toContain('no database is opened on');
    expect(source).toContain('never leaves the');
  });

  it('carries the version the package declares', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { version: string };
    expect(source).toContain(`const VERSION = '${pkg.version}'`);
  });
});
