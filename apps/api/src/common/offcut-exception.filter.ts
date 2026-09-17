/**
 * Maps core errors onto HTTP without inventing new ones.
 *
 * OffcutError already carries the status the specification implies - an
 * unauthorised cross-workspace probe is 403 with the same message as a missing
 * workspace, because SS7.1 forbids leaking even the existence of memory the
 * caller cannot see. This filter just forwards that decision.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { asZodError, isOffcutError } from '@offcut/core';

/**
 * `asZodError` is a structural check rather than `instanceof ZodError`, and it
 * lives in the core so all three surfaces share one definition.
 *
 * The reason it exists at all: @offcut/core and this app each resolve their own
 * copy of zod under pnpm, so a validation error thrown inside the core is an
 * instance of a DIFFERENT class than the one imported here. `instanceof`
 * silently returned false and every schema rejection surfaced as a 500 instead
 * of a 400 — a real bug the HTTP tests caught.
 *
 * The core now converts its own schema rejections before they escape, so what
 * still reaches this branch is the controller-level schemas below, which parse
 * request bodies the core never sees.
 */

@Catch()
export class OffcutExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (isOffcutError(exception)) {
      response.status(exception.status).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
        },
      });
      return;
    }

    const zodError = asZodError(exception);
    if (zodError) {
      response.status(400).json({
        error: {
          code: 'VALIDATION',
          message: zodError.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
          details: { issues: zodError.issues },
        },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response.status(exception.getStatus()).json({
        error: {
          code: 'HTTP',
          message: typeof body === 'string' ? body : (body as { message?: string }).message ?? exception.message,
          details: {},
        },
      });
      return;
    }

    // Anything unrecognised is logged in full but reported opaquely: an internal
    // stack trace is exactly the kind of metadata SS7.1 wants kept inside.
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong.', details: {} },
    });
  }
}
