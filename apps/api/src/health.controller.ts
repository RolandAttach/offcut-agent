import { Controller, Get } from '@nestjs/common';
import { getPrisma } from '@offcut/core';
import { Public } from './auth/principal.guard';

@Controller()
export class HealthController {
  /**
   * Reports what the local core needs to work, and nothing about any workspace.
   *
   * The token and external-model fields exist to make invariant 10 observable
   * from outside: the core runs without either, and this endpoint says so
   * rather than leaving it to be assumed.
   */
  @Public()
  @Get('health')
  async health() {
    let database: 'ok' | 'unreachable' = 'ok';
    try {
      await getPrisma().$queryRaw`SELECT 1`;
    } catch {
      database = 'unreachable';
    }

    return {
      service: 'offcut-agent-api',
      version: '3.1.0',
      database,
      // SS5 and invariant 10: memory operations need no wallet, gas or token.
      tokenRequired: false,
      // SS9: model summaries are an optional module, disabled by default.
      externalModel: 'disabled',
    };
  }
}
