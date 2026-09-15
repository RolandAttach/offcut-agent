/**
 * Which store, decided from the environment.
 *
 * The first of these is the one that matters most to everyone who already has
 * this installed: with no OFFCUT_API_URL the answer is "local", and that is
 * §7's first release, unchanged.
 */

import { describe, expect, it } from 'vitest';
import { chooseStore } from '../mode';

describe('chooseStore', () => {
  it('is local when OFFCUT_API_URL is unset', () => {
    expect(chooseStore({ OFFCUT_API_KEY: 'offcut_sk_x' })).toEqual({ kind: 'local' });
  });

  it('is local when OFFCUT_API_URL is set to nothing, which is how a config unsets it', () => {
    expect(chooseStore({ OFFCUT_API_URL: '' })).toEqual({ kind: 'local' });
    expect(chooseStore({ OFFCUT_API_URL: '   ' })).toEqual({ kind: 'local' });
  });

  it('is remote when a server is named', () => {
    expect(chooseStore({ OFFCUT_API_URL: 'https://offcut.tech' })).toEqual({
      kind: 'remote',
      baseUrl: 'https://offcut.tech',
    });
    expect(chooseStore({ OFFCUT_API_URL: ' http://localhost:4000 ' })).toEqual({
      kind: 'remote',
      baseUrl: 'http://localhost:4000',
    });
  });

  it('refuses something that is not a URL, by name, instead of guessing', () => {
    const choice = chooseStore({ OFFCUT_API_URL: 'offcut.tech' });
    expect(choice.kind).toBe('refused');
    expect(choice.kind === 'refused' && choice.message).toContain('offcut.tech');
  });

  it('refuses a scheme that is not http or https', () => {
    const choice = chooseStore({ OFFCUT_API_URL: 'file:///c:/offcut.db' });
    expect(choice.kind).toBe('refused');
  });
});
