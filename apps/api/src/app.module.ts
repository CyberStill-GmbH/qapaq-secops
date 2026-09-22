import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { ApiLifecycle } from './lifecycle.js';
import { READINESS_CONTRIBUTORS, type ReadinessContributor } from './health/readiness.js';

@Module({})
export class AppModule {
  public static compose(
    lifecycle: ApiLifecycle,
    contributors: readonly ReadinessContributor[] = [],
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: ApiLifecycle, useValue: lifecycle },
        { provide: READINESS_CONTRIBUTORS, useValue: contributors },
      ],
    };
  }
}
