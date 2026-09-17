import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { config } from './common/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.use(cookieParser());
  app.setGlobalPrefix('api');

  // The console runs on its own origin in development, so cookies need an
  // explicit allow-list rather than a wildcard (credentials forbid '*').
  app.enableCors({
    origin: [config.webOrigin],
    credentials: true,
  });

  await app.listen(config.port, config.host);

  const logger = new Logger('offcut');
  logger.log(`API listening on http://${config.host}:${config.port}/api`);
  logger.log(`Console origin allowed: ${config.webOrigin}`);
}

bootstrap().catch((error) => {
  console.error('Failed to start the API:', error);
  process.exit(1);
});
