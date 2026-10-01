import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { ApiLifecycle } from './lifecycle.js';
import { READINESS_CONTRIBUTORS, type ReadinessContributor } from './health/readiness.js';
import { SocModule } from './soc/soc.module.js';
import type { SecOpsRuntime } from './runtime/secops-runtime.js';

@Module({})
export class AppModule {
  public static compose(
    lifecycle: ApiLifecycle,
    contributors: readonly ReadinessContributor[] = [],
    runtime?: SecOpsRuntime,
  ): DynamicModule {
    return {
      module: AppModule,
      // El BFF solo se monta si hay runtime: C-02 conserva su arranque mínimo sin él.
      imports: runtime ? [SocModule.compose(runtime)] : [],
      controllers: [HealthController],
      providers: [
        { provide: ApiLifecycle, useValue: lifecycle },
        { provide: READINESS_CONTRIBUTORS, useValue: contributors },
      ],
    };
  }
}
