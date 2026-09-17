/**
 * Sign-In-With-Ethereum: the second door, never the gate.
 *
 * THE RULE THIS FILE LIVES UNDER. §5, line 151: "for memory operations no
 * wallet, gas or token purchase is needed", and line 261 lists requiring a
 * wallet on every request as the REJECTED option. So nothing here may ever
 * become a condition of using memory. It is an additional way to reach an
 * account, standing beside email and password, and an account that never sees
 * a wallet works exactly as well.
 *
 * WHAT IS SIGNED. A plain text message, and nothing else. Line 19 rules out
 * "signing transactions"; a signature over a string is not a transaction - it
 * costs no gas, moves no funds, touches no contract and grants no allowance.
 * The statement below says so in the wallet's own dialog, because the person
 * holding the wallet is the one who has to believe it.
 *
 * WHY THE CHAIN IS CONSULTED AT ALL. A smart-account wallet has no private key
 * to recover an address from: its signature is valid because a contract says it
 * is (ERC-1271), and only the chain can be asked. Refusing those wallets would
 * quietly mean "sign in with an EOA or not at all". So verification runs
 * through a public client - and if that client cannot reach the chain, this
 * module REFUSES. It never decides on its own that a signature is probably
 * fine: an unverifiable signature and an invalid one are the same thing here,
 * and the caller is told which of the two happened.
 */

import { createPublicClient, http, type PublicClient, type Transport } from 'viem';
import { parseSiweMessage, validateSiweMessage, type SiweMessage } from 'viem/siwe';
import { OffcutError } from '@offcut/core';
import { config } from '../common/config';
import { ACCEPTED_CHAIN_IDS, activeChain } from '../common/chains';

/**
 * The sentence the wallet shows the person signing.
 *
 * Enforced verbatim, not merely suggested. A signature is a bearer token for
 * whatever it says: if this server accepted any statement, a signature somebody
 * was talked into producing on another site could be spent here. Requiring
 * these exact words means a signature made for OFFCUT only works on OFFCUT, and
 * that the promise in them was on screen when it was made.
 */
export const SIWE_STATEMENT =
  'Sign in to OFFCUT AGENT. This signature is free, moves nothing and grants nothing - ' +
  'it only proves you hold this address. OFFCUT never asks you to sign a transaction, ' +
  'and memory never needs a wallet at all.';

/** How stale an issuedAt may be. A wallet dialog left open is not a session. */
export const SIWE_ISSUED_AT_MAX_AGE_MS = 10 * 60_000;

/** Small tolerance for a client whose clock runs ahead of this server's. */
const CLOCK_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------
// The chain client
// ---------------------------------------------------------------------------

let transportOverride: Transport | null = null;
let cached: PublicClient | null = null;

function chainClient(): PublicClient {
  if (!cached) {
    cached = createPublicClient({
      chain: activeChain,
      transport: transportOverride ?? http(),
    }) as PublicClient;
  }
  return cached;
}

/**
 * Test hook: replaces the JSON-RPC wire, and nothing above it.
 *
 * The seam is deliberately this low. Stubbing the verifier itself would leave
 * the suite proving that a stub says no to a bad signature, which proves
 * nothing at all - so viem's real verification runs in tests, over a transport
 * the test controls. Pass null to go back to the network.
 */
export function setSiweTransport(next: Transport | null): void {
  transportOverride = next;
  // The next caller builds a client on the new wire; a cached one would keep
  // talking to the old.
  cached = null;
}

/** The refusal that says the server could not do its job, not that you failed. */
function chainUnreachable(): OffcutError {
  // 503 carrying the VALIDATION code, the shape the rate-limit guard already
  // uses for its 429: a dedicated code would have to be added to
  // OffcutErrorCode, which changes how all three surfaces map errors (§4,
  // invariant 8). The status and the words carry the meaning - nobody was
  // signed in, try again.
  return new OffcutError(
    'VALIDATION',
    `${activeChain.name} could not be reached, so this signature was not checked and nobody was ` +
      'signed in. Nothing was spent and nothing was signed away. Try again in a moment, or sign ' +
      'in with an email and password instead.',
    { status: 503, details: { chainId: activeChain.id } }
  );
}

function refused(message: string): OffcutError {
  return new OffcutError('UNAUTHENTICATED', message, { status: 401 });
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** A parsed message with every field this server insists on actually present. */
export interface CheckedSiweMessage extends SiweMessage {
  address: `0x${string}`;
  nonce: string;
  issuedAt: Date;
}

function originOf(uri: string): string | null {
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

/**
 * Checks everything about the message except the signature.
 *
 * Order matters only for the quality of the refusal: each check names the one
 * thing that was wrong, because the caller here is a console developer wiring a
 * wallet up, not an attacker who learns anything from being told the chain id
 * was wrong. What must never differ by case is whether an ACCOUNT exists - and
 * nothing in this function has looked one up yet.
 */
export function checkSiweMessage(
  message: string,
  expectedNonce: string,
  now: Date = new Date()
): CheckedSiweMessage {
  const fields = parseSiweMessage(message);

  if (!fields.address || !fields.domain || !fields.uri || !fields.nonce || !fields.issuedAt) {
    throw new OffcutError(
      'VALIDATION',
      'That is not a Sign-In-With-Ethereum message. It must carry a domain, an address, a URI, ' +
        'a nonce and an issuedAt.',
      { status: 400 }
    );
  }

  if (fields.version !== '1') {
    throw refused('Only version 1 of the Sign-In-With-Ethereum format is accepted.');
  }

  // The configured console host, never the request's Host header: see hostOf()
  // in common/config.ts for why the header cannot be trusted here.
  if (fields.domain !== config.webHost) {
    throw refused(
      `This signature was made for "${fields.domain}". It signs in at "${config.webHost}" and nowhere else.`
    );
  }

  if (originOf(fields.uri) !== config.webOrigin) {
    throw refused(`The message's uri must be a page of ${config.webOrigin}.`);
  }

  if (fields.statement !== SIWE_STATEMENT) {
    throw refused(
      "The message does not carry this service's statement, so it was signed for something else."
    );
  }

  if (typeof fields.chainId !== 'number' || !ACCEPTED_CHAIN_IDS.includes(fields.chainId)) {
    throw refused(`Chain ${String(fields.chainId)} is not a network this service knows.`);
  }

  if (fields.chainId !== activeChain.id) {
    throw refused(
      `This server signs in on ${activeChain.name} (chain ${activeChain.id}); the message names ` +
        `chain ${fields.chainId}.`
    );
  }

  // Compared before the signature is checked, so a replay costs an attacker
  // nothing but a round trip - and the nonce was spent in the store before this
  // function was called, so it costs them the nonce either way.
  if (fields.nonce !== expectedNonce) {
    throw refused('That nonce is not the one this browser was given. Ask for a new one and sign again.');
  }

  if (fields.expirationTime && fields.expirationTime.getTime() <= now.getTime()) {
    throw refused('This signature has expired. Sign again.');
  }

  if (fields.notBefore && fields.notBefore.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw refused('This signature is not valid yet.');
  }

  const age = now.getTime() - fields.issuedAt.getTime();
  if (age > SIWE_ISSUED_AT_MAX_AGE_MS) {
    throw refused('This signature was made too long ago. Sign again.');
  }
  if (age < -CLOCK_SKEW_MS) {
    throw refused('This signature claims to have been made in the future.');
  }

  // viem's own gate, last and deliberately redundant. The checks above produce
  // the sentence a developer can act on; this one makes sure our reading of the
  // format and the library's cannot drift apart without the door shutting.
  const valid = validateSiweMessage({
    message: fields,
    domain: config.webHost,
    nonce: expectedNonce,
    time: now,
  });
  if (!valid) throw refused('This Sign-In-With-Ethereum message was refused.');

  return fields as CheckedSiweMessage;
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/**
 * Verifies the signature against the chain, or refuses to answer.
 *
 * The chain is greeted first. That greeting is what separates "this signature
 * is invalid" from "I could not check": viem's verifier answers false for both
 * a bad signature and an RPC that never replied, and reporting an outage as a
 * forged signature would tell an owner their wallet is broken. It also catches
 * an RPC pointed at the wrong network, which would otherwise check a
 * smart-account signature against a contract on some other chain.
 */
export async function verifyWalletSignature(params: {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}): Promise<void> {
  const client = chainClient();

  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    throw chainUnreachable();
  }
  if (chainId !== activeChain.id) throw chainUnreachable();

  let verified: boolean;
  try {
    verified = await client.verifyMessage({
      address: params.address,
      message: params.message,
      signature: params.signature,
    });
  } catch {
    // Anything the verifier could not turn into a yes or a no is an outage, not
    // a verdict. Never accept unverified.
    throw chainUnreachable();
  }

  if (!verified) {
    throw refused('That signature was not made by the address in the message.');
  }
}
