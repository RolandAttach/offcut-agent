/**
 * Resolves the caller into a Principal, exactly as the SDK and MCP server do.
 *
 * Two credentials are accepted and they map to the two participant kinds of SS2:
 *
 *   Authorization: Bearer offcut_sk_...   an agent, identity from the key
 *   offcut_session cookie                 a human owner, identity from the session
 *
 * Both end up calling the same authenticate* functions in @offcut/core. The HTTP
 * layer decides nothing about permissions; it only establishes who is asking.
 * That is what keeps this third surface inside invariant 8 rather than beside it.
 */

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { authenticateAgent, authenticateUser, errors, type Principal } from '@offcut/core';
import { config } from '../common/config';

export const PUBLIC_ROUTE = 'offcut:public';
/** Marks a route reachable without any credential (login, register, health). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

export interface RequestWithPrincipal extends Request {
  principal?: Principal;
}

@Injectable()
export class PrincipalGuard implements CanActivate {
  /**
   * Tokens are named explicitly rather than inferred from parameter types.
   * The dev runner (tsx/esbuild) does not emit `design:paramtypes`, which is
   * what Nest's implicit injection reads, so type-only injection silently
   * resolves to undefined. Explicit tokens work under every compiler.
   */
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();

    // An agent key wins when both are present: it is the more specific claim.
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      request.principal = await authenticateAgent(header.slice('Bearer '.length));
      return true;
    }

    const token = (request.cookies as Record<string, string> | undefined)?.[config.sessionCookie];
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub?: unknown }>(token);
        // Every token this server signs uses one secret, and the SIWE nonce is
        // one of them (auth/siwe.ts). A nonce pasted into the session cookie
        // verifies perfectly and carries no `sub`, so without this check it
        // would reach authenticateUser as undefined and come back a 500 rather
        // than a refusal.
        if (typeof payload.sub !== 'string' || !payload.sub) {
          throw errors.unauthenticated('That is not a session token.');
        }
        request.principal = await authenticateUser(payload.sub);
        return true;
      } catch {
        // A malformed or expired cookie is treated as no credential at all.
        if (isPublic) return true;
        throw errors.unauthenticated('Session expired. Sign in again.');
      }
    }

    if (isPublic) return true;
    throw errors.unauthenticated('Sign in, or send an agent key as a Bearer token.');
  }
}

/** Injects the resolved principal into a handler parameter. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    if (!request.principal) throw errors.unauthenticated();
    return request.principal;
  }
);

/**
 * Injects the principal only when a human session is required.
 *
 * `email` is nullable because an account opened by signing with a wallet never
 * gave one. Anything that needs a name to print uses displayName, which every
 * account has - a wallet account is named after its own address.
 */
export const CurrentUser = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext
  ): { userId: string; email: string | null; displayName: string } => {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;
    if (!principal || principal.kind !== 'user') {
      throw errors.accessDenied('this endpoint requires a signed-in account');
    }
    return {
      userId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
    };
  }
);
