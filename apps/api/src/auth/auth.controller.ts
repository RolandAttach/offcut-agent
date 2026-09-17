/**
 * Console accounts.
 *
 * These endpoints authenticate humans only. Agents never register or log in:
 * their identity is the key they hold (SS3.2), which is minted by an owner and
 * has no password, no session and no self-service path.
 *
 * There are two doors for a human and neither one is the main one. An email and
 * a password is one; a wallet that signed a Sign-In-With-Ethereum message is
 * the other. §5, line 151 - "for memory operations no wallet, gas or token
 * purchase is needed" - is why the second one can only ever be additional: an
 * account that never touches a wallet reaches every part of memory, and line
 * 261 names "require a wallet on every request" as the rejected design.
 */

import { Body, Controller, Delete, Get, Inject, Post, Put, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  OffcutError,
  createUser,
  findOrCreateUserByWallet,
  getLinkedWallet,
  linkWallet,
  spendSiweNonce,
  unlinkWallet,
  verifyUserCredentials,
} from '@offcut/core';
import { generateSiweNonce } from 'viem/siwe';
import { config } from '../common/config';
import { RateLimit } from '../common/rate-limit.guard';
import { CurrentUser, Public } from './principal.guard';
import { checkSiweMessage, verifyWalletSignature } from './siwe';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  displayName: z.string().trim().min(1).max(80),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Only that a string arrived. What counts as an address is decided in the core,
// so the SDK and this surface cannot disagree about it (invariant 8).
const walletSchema = z.object({ address: z.string() });

/**
 * A signature is 0x and hex; the length is not pinned because a smart-account
 * signature (ERC-1271) is as long as its contract says it is. The bound is only
 * there so nothing absurd reaches the verifier.
 */
const siweVerifySchema = z.object({
  message: z.string().min(1).max(8_000),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'A signature is 0x followed by hexadecimal characters.')
    .max(8_000),
});

/** Distinguishes the nonce token from the session token, which shares its key. */
const SIWE_NONCE_PURPOSE = 'siwe-nonce';

/** What every account-shaped response returns, whichever door was used. */
interface UserView {
  id: string;
  /** Null for an account that has only ever been a wallet. */
  email: string | null;
  displayName: string;
  /** Present only when an address is on the account; provenAt says if it signed. */
  wallet: { address: string; provenAt: string | null } | null;
}

@Controller('auth')
export class AuthController {
  // Explicit token: see the note in principal.guard.ts about decorator metadata.
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  // Account creation is the most abusable unauthenticated endpoint, and each
  // call runs scrypt. Five an hour is far above honest use and far below useful
  // abuse.
  @RateLimit({ limit: 5, windowMs: 60 * 60_000, label: 'sign-up attempts' })
  @Public()
  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = registerSchema.parse(body);
    const user = await createUser(input);
    await this.issueSession(response, user.id);
    return { user };
  }

  // Tight enough to make password guessing pointless, loose enough that a
  // person mistyping their own password a few times is not locked out.
  @RateLimit({ limit: 10, windowMs: 15 * 60_000, label: 'sign-in attempts' })
  @Public()
  @Post('login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = loginSchema.parse(body);
    const user = await verifyUserCredentials(input.email, input.password);
    await this.issueSession(response, user.id);
    return { user };
  }

  @Public()
  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(config.sessionCookie, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  async me(@CurrentUser() user: { userId: string; email: string | null; displayName: string }) {
    return { user: await this.userView(user.userId, user.email, user.displayName) };
  }

  // -------------------------------------------------------------------------
  // The wallet door
  // -------------------------------------------------------------------------
  //
  // Two requests. The nonce the server minted comes back inside a cookie it
  // signed itself, so there is no table of live nonces waiting to be spent -
  // only a row per nonce actually presented, written when it arrives, which is
  // what makes that first presentation the last one.

  /**
   * Hands out one nonce and remembers it in a cookie only this server can read.
   *
   * httpOnly, so no script on the console page can lift it; sameSite=lax, so
   * another site cannot make the browser spend it; five minutes, because a
   * nonce is a round trip, not a session.
   *
   * Nothing is written here. A nonce nobody ever presents costs this server a
   * signature and no storage at all; the row that makes it single-use is
   * written by the half that presents it.
   */
  @RateLimit({ limit: 30, windowMs: 15 * 60_000, label: 'nonce requests' })
  @Public()
  @Get('siwe/nonce')
  async siweNonce(@Res({ passthrough: true }) response: Response) {
    const nonce = generateSiweNonce();
    const token = await this.jwt.signAsync(
      { nonce, purpose: SIWE_NONCE_PURPOSE },
      { expiresIn: Math.floor(config.siweNonceMaxAgeMs / 1000) }
    );

    response.cookie(config.siweCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: config.siweNonceMaxAgeMs,
      path: '/',
    });

    return { nonce };
  }

  /**
   * Spends the nonce, checks the message, checks the signature, signs in.
   *
   * The nonce is spent FIRST, before a single field is read. One nonce, one use
   * has to mean one attempt: spending it only on success would let somebody who
   * intercepted a signature retry it against the same nonce as often as they
   * liked, and a refusal is exactly the moment an attacker would want another
   * go.
   *
   * Spending is a row, not the cookie. The clearCookie below tidies a browser
   * up and proves nothing about anyone else: a client that ignores Set-Cookie -
   * curl, a proxy, anything replaying a request out of an access log or a HAR -
   * keeps sending the same cookie, and for five minutes that was every session
   * it wanted. Reproduced with three identical POSTs and three fresh sessions
   * before the spend moved into the store.
   *
   * A wallet arriving here is signing in, not connecting a payout address, and
   * nothing about this request asks for a transaction (line 19). The session it
   * issues is the same cookie the email door issues - past this point the two
   * doors are indistinguishable, which is what keeps memory reachable without a
   * wallet (§5, line 151).
   */
  @RateLimit({ limit: 10, windowMs: 15 * 60_000, label: 'wallet sign-in attempts' })
  @Public()
  @Post('siwe/verify')
  async siweVerify(
    @Req() request: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response
  ) {
    const input = siweVerifySchema.parse(body);

    const cookie = (request.cookies as Record<string, string> | undefined)?.[config.siweCookie];
    // Housekeeping for the browser that will obey it, and the reason the
    // console never sends a dead nonce back. The spend is in spentNonce().
    response.clearCookie(config.siweCookie, { path: '/' });

    const nonce = await this.spentNonce(cookie);
    const fields = checkSiweMessage(input.message, nonce);

    await verifyWalletSignature({
      address: fields.address,
      message: input.message,
      signature: input.signature as `0x${string}`,
    });

    const user = await findOrCreateUserByWallet(fields.address);
    await this.issueSession(response, user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        wallet: { address: user.wallet.address, provenAt: user.wallet.provenAt },
      } satisfies UserView,
    };
  }

  // -------------------------------------------------------------------------
  // Payout address
  // -------------------------------------------------------------------------
  //
  // On this controller because a wallet follows the person, not a workspace:
  // rewards are earned by records in every workspace an owner has, and they are
  // paid to one address.

  /**
   * PUT, not POST: sending the same address twice has to mean the same as
   * sending it once - the console retries this on a dropped connection.
   */
  @Put('wallet')
  async setWallet(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const input = walletSchema.parse(body);
    return {
      wallet: await linkWallet(user.userId, input.address),
      notice:
        'This records where to pay. It does not prove you control this address - nothing was signed.',
    };
  }

  @Delete('wallet')
  async clearWallet(@CurrentUser() user: { userId: string }) {
    return {
      wallet: await unlinkWallet(user.userId),
      notice: 'Nothing earned is lost. Credits are counted per record, not held on a wallet.',
    };
  }

  /**
   * Reads the nonce out of the cookie this server signed, and spends it.
   *
   * The cookie answers two questions - is this nonce ours, and is it still
   * young - and it cannot answer the third, because whoever holds a copy of the
   * request holds a copy of the cookie. So the third answer comes from the
   * store: spendSiweNonce writes a row and reports whether this call is the one
   * that wrote it. Two replays arriving together are settled by the unique
   * index, not by whichever reached the verifier first.
   *
   * Every failure - no cookie, a tampered one, one that has aged out, a session
   * token pasted in its place, or a nonce already spent - is the same sentence,
   * because the only useful reply is "start again", and because which of those
   * happened is not an attacker's business.
   */
  private async spentNonce(cookie: string | undefined): Promise<string> {
    const refusal = new OffcutError(
      'UNAUTHENTICATED',
      'This sign-in has no live nonce. Ask for one and sign within five minutes.',
      { status: 401 }
    );

    if (!cookie) throw refusal;

    let nonce: string;
    let expiresAt: Date;

    try {
      const payload = await this.jwt.verifyAsync<{
        nonce?: unknown;
        purpose?: unknown;
        exp?: unknown;
      }>(cookie);
      // A session cookie verifies against this same secret. It carries no
      // purpose, so it can never be spent as a nonce.
      if (payload.purpose !== SIWE_NONCE_PURPOSE) throw refusal;
      if (typeof payload.nonce !== 'string' || !payload.nonce) throw refusal;
      // Always set by signAsync above. A token without it could be presented
      // for longer than the row that remembers it would be kept, so it is
      // refused rather than given an expiry this method invented.
      if (typeof payload.exp !== 'number') throw refusal;

      nonce = payload.nonce;
      expiresAt = new Date(payload.exp * 1000);
    } catch {
      throw refusal;
    }

    // Outside the catch on purpose: a store that cannot answer must surface as
    // a store that cannot answer. Dressing it as "no live nonce" would tell an
    // owner to sign again at the one moment signing again cannot work.
    if (!(await spendSiweNonce(nonce, expiresAt))) throw refusal;

    return nonce;
  }

  /** The /auth/me body, assembled once so both doors return the same shape. */
  private async userView(
    userId: string,
    email: string | null,
    displayName: string
  ): Promise<UserView> {
    const wallet = await getLinkedWallet(userId);
    return {
      id: userId,
      email,
      displayName,
      // provenAt, not linkedAt, is what tells the console which door was used:
      // an address typed into PUT /auth/wallet proved nothing and says so.
      wallet: wallet.address ? { address: wallet.address, provenAt: wallet.provenAt } : null,
    };
  }

  private async issueSession(response: Response, userId: string): Promise<void> {
    const token = await this.jwt.signAsync({ sub: userId });

    response.cookie(config.sessionCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: config.sessionMaxAgeMs,
      path: '/',
    });
  }
}
