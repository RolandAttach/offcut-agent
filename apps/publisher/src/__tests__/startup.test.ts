/**
 * What this service refuses to do.
 *
 * A publisher that starts without a key, or with a key the contract will not
 * accept, looks perfectly healthy for ten minutes and then fails in a log
 * nobody is reading. Both of those are configuration mistakes and both are
 * knowable at startup, so both are refused there.
 *
 * The other subject here is the key itself. It is the credential most likely to
 * be stolen in this whole system - it sits on a server and signs every ten
 * minutes - and the easiest way to leak it is an error message. So one of these
 * tests exists purely to assert that a bad key never turns up in the complaint
 * about it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { assertIsPublisher, loadConfig, loadSigner } from '../config';
import { fakeChain } from './fakes';

const CONTRACT = '0x3333333333333333333333333333333333333333';

/** A real key, generated here, so nothing that looks like a secret is committed. */
const throwaway = Wallet.createRandom();

const temporary: string[] = [];

function keyFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-publisher-key-'));
  temporary.push(dir);
  const file = path.join(dir, 'publisher.key');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe('Starting without a key', () => {
  it('refuses, and names both ways to supply one', () => {
    let thrown: Error | null = null;
    try {
      loadSigner({});
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain('OFFCUT_PUBLISHER_KEY');
    expect(thrown?.message).toContain('OFFCUT_PUBLISHER_KEY_FILE');
  });

  it('refuses a dry run too, and says an unfunded key is enough for one', () => {
    // A dry run is where somebody first tries this, so the message has to
    // answer the question they are about to ask.
    expect(() => loadSigner({ OFFCUT_PUBLISHER_DRY_RUN: '1' })).toThrow(/DRY_RUN/);
  });
});

describe('Where the key comes from', () => {
  it('reads it from the environment', () => {
    const signer = loadSigner({ OFFCUT_PUBLISHER_KEY: throwaway.privateKey });
    expect(signer.address).toBe(throwaway.address);
  });

  it('reads it from the file named in OFFCUT_PUBLISHER_KEY_FILE, trailing newline and all', () => {
    const file = keyFile(`${throwaway.privateKey}\n`);
    expect(loadSigner({ OFFCUT_PUBLISHER_KEY_FILE: file }).address).toBe(throwaway.address);
  });

  it('reads the file `pnpm --filter @offcut/contracts keys` writes, labels and phrase and all', () => {
    const file = keyFile(
      [
        'OFFCUT PUBLISHER KEY',
        'Generated 2026-09-15 on this machine. Never sent anywhere.',
        '',
        'ADDRESS   ' + throwaway.address,
        '',
        'PRIVATE KEY - never paste into a chat, an email, a form, or a web page.',
        '          ' + throwaway.privateKey,
        '',
        'RECOVERY PHRASE - anyone who reads these twelve words owns this wallet.',
        '          ' + (throwaway.mnemonic?.phrase ?? 'twelve words here'),
        '',
      ].join('\n')
    );
    expect(loadSigner({ OFFCUT_PUBLISHER_KEY_FILE: file }).address).toBe(throwaway.address);
  });

  it('accepts a key written without the 0x', () => {
    const file = keyFile(throwaway.privateKey.slice(2));
    expect(loadSigner({ OFFCUT_PUBLISHER_KEY_FILE: file }).address).toBe(throwaway.address);
  });

  it('refuses to choose when the key is supplied twice', () => {
    // Precedence would mean a stale variable silently beating the file somebody
    // just rotated, and the only symptom is signatures the contract rejects.
    expect(() =>
      loadSigner({
        OFFCUT_PUBLISHER_KEY: throwaway.privateKey,
        OFFCUT_PUBLISHER_KEY_FILE: keyFile(throwaway.privateKey),
      })
    ).toThrow(/will not choose/);
  });

  it('names the file it could not read, since the path is the operator’s own', () => {
    const missing = path.join(os.tmpdir(), 'offcut-publisher-does-not-exist', 'publisher.key');
    expect(() => loadSigner({ OFFCUT_PUBLISHER_KEY_FILE: missing })).toThrow(/could not be read/);
  });

  it('refuses an empty key file rather than deriving a wallet from nothing', () => {
    expect(() => loadSigner({ OFFCUT_PUBLISHER_KEY_FILE: keyFile('   \n') })).toThrow(/is empty/);
  });
});

describe('A key that will not parse', () => {
  it('never puts the value, or its length, into the error it causes', () => {
    // A truncated real key is still most of a real key, and a log aggregator
    // keeps it forever.
    const nearly = `${throwaway.privateKey.slice(0, 40)}deadbeef`;

    let message = '';
    try {
      loadSigner({ OFFCUT_PUBLISHER_KEY: nearly });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('not a valid private key');
    expect(message).not.toContain(nearly);
    expect(message).not.toContain(nearly.slice(2, 12));
    expect(message).not.toContain(String(nearly.length));
  });

  it('says the same thing whether the key came from the environment or a file', () => {
    const rubbish = '0xnotakey';
    const fromEnv = (() => {
      try {
        loadSigner({ OFFCUT_PUBLISHER_KEY: rubbish });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();

    let fromFile = '';
    try {
      loadSigner({ OFFCUT_PUBLISHER_KEY_FILE: keyFile(rubbish) });
    } catch (error) {
      fromFile = (error as Error).message;
    }

    expect(fromEnv).toBe(fromFile);
    expect(fromFile).not.toContain(rubbish);
  });
});

describe('A key the contract will not accept', () => {
  it('refuses to start, rather than discovering it at minute ten', async () => {
    const chain = fakeChain({
      signer: '0x9999999999999999999999999999999999999999',
      publisher: '0x8888888888888888888888888888888888888888',
    });

    await expect(assertIsPublisher(chain)).rejects.toThrow(/only accepts roots from/);
  });

  it('names both addresses, so the fix is one call to setPublisher', async () => {
    const signer = '0x9999999999999999999999999999999999999999';
    const publisher = '0x8888888888888888888888888888888888888888';
    const chain = fakeChain({ signer, publisher });

    const message = await assertIsPublisher(chain).catch((error: Error) => error.message);

    expect(message).toContain(signer);
    expect(message).toContain(publisher);
    expect(message).toContain('setPublisher');
  });

  it('explains a contract it could not read at all, rather than passing on a decoding error', async () => {
    // What an address that is right for another network, or that names the
    // implementation instead of the proxy, actually looks like from here: the
    // call returns nothing and ethers complains about decoding.
    const unreadable = {
      ...fakeChain(),
      publisher: async () => {
        throw new Error('could not decode result data (value="0x", info={ "method": "publisher" })');
      },
    };

    const message = await assertIsPublisher(unreadable).catch((error: Error) => error.message);

    expect(message).toContain('Could not read publisher()');
    expect(message).toContain('proxy');
    expect(message).not.toContain('could not decode result data');
  });

  it('starts when the addresses match, whatever case they are written in', async () => {
    const chain = fakeChain({ signer: '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa' });
    chain.setPublisher('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await expect(assertIsPublisher(chain)).resolves.toBeUndefined();
  });
});

describe('An RPC that is not answering yet', () => {
  const rateLimited = () => {
    throw new Error('server response 429 Rate Limit Hit, limit will reset in 60 seconds');
  };

  it('retries the first read across the configured pauses and then goes on', async () => {
    let calls = 0;
    const chain = {
      ...fakeChain(),
      publisher: async () => {
        calls += 1;
        if (calls < 3) rateLimited();
        return '0x9999999999999999999999999999999999999999';
      },
    };
    const slept: number[] = [];
    const warned: string[] = [];

    await expect(
      assertIsPublisher(chain, {
        delaysMs: [5_000, 15_000, 30_000],
        sleep: async (ms) => {
          slept.push(ms);
        },
        log: { warn: (line) => warned.push(line) },
      })
    ).resolves.toBeUndefined();

    expect(calls).toBe(3);
    expect(slept).toEqual([5_000, 15_000]);
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain('429');
    expect(warned[0]).toContain('retrying in 5 s (1 of 3)');
  });

  it('gives up with the configuration error once the pauses are spent', async () => {
    let calls = 0;
    const chain = {
      ...fakeChain(),
      publisher: async () => {
        calls += 1;
        rateLimited();
        return '';
      },
    };
    const slept: number[] = [];

    const message = await assertIsPublisher(chain, {
      delaysMs: [1, 2],
      sleep: async (ms) => {
        slept.push(ms);
      },
      log: { warn: () => undefined },
    }).catch((error: Error) => error.message);

    expect(calls).toBe(3);
    expect(slept).toEqual([1, 2]);
    expect(message).toContain('Could not read publisher()');
  });

  it('makes a single attempt when no policy is given', async () => {
    let calls = 0;
    const chain = {
      ...fakeChain(),
      publisher: async () => {
        calls += 1;
        rateLimited();
        return '';
      },
    };
    await expect(assertIsPublisher(chain)).rejects.toThrow(/Could not read publisher/);
    expect(calls).toBe(1);
  });
});

describe('The rest of the configuration', () => {
  it('refuses to start without a contract address', () => {
    expect(() => loadConfig({})).toThrow(/OFFCUT_CONTRACT_ADDRESS is not set/);
  });

  it('refuses an address that is not one', () => {
    expect(() => loadConfig({ OFFCUT_CONTRACT_ADDRESS: '0xnope' })).toThrow(/is not an Ethereum address/);
  });

  it('takes the period length from the reward policy, never from its own setting', () => {
    // The daily ceiling is divided by the number of periods in a day. A
    // publisher running on a different period length than the accrual was
    // written for would emit a multiple of what was intended.
    const config = loadConfig({
      OFFCUT_CONTRACT_ADDRESS: CONTRACT,
      OFFCUT_REWARD_PERIOD_MINUTES: '30',
    });

    expect(config.reward.periodMinutes).toBe(30);
    expect(config.periodMs).toBe(30 * 60_000);
  });

  it('refuses a reward policy that cannot be applied, before any key is read', () => {
    expect(() =>
      loadConfig({ OFFCUT_CONTRACT_ADDRESS: CONTRACT, OFFCUT_REWARD_PERIOD_MINUTES: '7' })
    ).toThrow(/divide a day evenly/);
  });

  it('defaults to mainnet and switches on an explicit OFFCUT_NETWORK', () => {
    expect(loadConfig({ OFFCUT_CONTRACT_ADDRESS: CONTRACT }).chainId).toBe(4663);
    expect(
      loadConfig({ OFFCUT_CONTRACT_ADDRESS: CONTRACT, OFFCUT_NETWORK: 'testnet' }).chainId
    ).toBe(46630);
  });

  it('is off by default, so a dry run is something somebody asked for', () => {
    expect(loadConfig({ OFFCUT_CONTRACT_ADDRESS: CONTRACT }).dryRun).toBe(false);
    expect(
      loadConfig({ OFFCUT_CONTRACT_ADDRESS: CONTRACT, OFFCUT_PUBLISHER_DRY_RUN: '1' }).dryRun
    ).toBe(true);
  });

  it('keeps nothing worth stealing on the config object', () => {
    // Config objects get logged whole by the next person debugging something.
    const config = loadConfig({
      OFFCUT_CONTRACT_ADDRESS: CONTRACT,
      OFFCUT_PUBLISHER_KEY: throwaway.privateKey,
    });

    expect(JSON.stringify(config, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)))
      .not.toContain(throwaway.privateKey);
  });
});
