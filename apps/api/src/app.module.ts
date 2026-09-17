import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { PrincipalGuard } from './auth/principal.guard';
import { MemoryController } from './memory/memory.controller';
import { WorkspacesController } from './workspaces/workspaces.controller';
import { SummariesController } from './summaries/summaries.controller';
import { RewardsController } from './rewards/rewards.controller';
import { UsageController } from './usage/usage.controller';
import { OffcutExceptionFilter } from './common/offcut-exception.filter';
import { RateLimitGuard } from './common/rate-limit.guard';
import { HealthController } from './health.controller';
import { config, sessionSecret } from './common/config';

/**
 * The HTTP surface.
 *
 * THERE IS NO BACKUPS CONTROLLER, AND THAT IS THE POINT.
 *
 * A snapshot is every row of the installation: every account, every agent key
 * hash, every record any owner ever wrote. SS3.1 knows one role — the owner of a
 * workspace — and names reaching another owner's workspace by holding a
 * credential as the thing that role exists to prevent. A session cookie proves
 * an account; nothing at this layer can promote it to operator of the machine.
 * So no session reads the installation row counts, learns the path snapshots
 * are written to, causes one to be written, or deletes one.
 *
 * That is the argument restore was already held to, applied to the other three
 * verbs. Snapshots live entirely where restore lives — `pnpm backup`,
 * `backup:list`, `backup:prune`, `backup:restore <file>` — with the person who
 * already has a shell on the machine that owns the data.
 *
 * The owner-scoped door is unaffected: POST /workspaces/:id/memory/export
 * hands an owner their own records, and nobody else any.
 */
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: sessionSecret(),
      signOptions: { expiresIn: `${Math.floor(config.sessionMaxAgeMs / 1000)}s` },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    WorkspacesController,
    MemoryController,
    SummariesController,
    RewardsController,
    UsageController,
  ],
  providers: [
    // Order matters: rate limiting runs BEFORE authentication, so a flood of
    // bad credentials is rejected without ever touching the password hasher.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Applied globally: no route is reachable without a resolved principal
    // unless it opts out with @Public (SS4: the Access Layer sits on every path).
    { provide: APP_GUARD, useClass: PrincipalGuard },
    { provide: APP_FILTER, useClass: OffcutExceptionFilter },
  ],
})
export class AppModule {}
