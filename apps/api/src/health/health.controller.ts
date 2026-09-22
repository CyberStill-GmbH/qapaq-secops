import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiLifecycle } from '../lifecycle.js';
import { READINESS_CONTRIBUTORS, type ReadinessContributor } from './readiness.js';

/** Agregar comprobaciones reales cuando las dependencias estén implementadas. */
@Controller('health')
export class HealthController {
  public constructor(
    @Inject(ApiLifecycle) private readonly lifecycle: ApiLifecycle,
    @Inject(READINESS_CONTRIBUTORS) private readonly contributors: readonly ReadinessContributor[],
  ) {}
  @Get('live')
  public live() {
    if (this.lifecycle.state === 'stopped' || this.lifecycle.state === 'failed') {
      throw new ServiceUnavailableException({ status: 'unavailable', service: 'qapaq-secops-api' });
    }
    return { status: 'ok', service: 'qapaq-secops-api' };
  }
  @Get('ready')
  public async ready() {
    const available =
      this.lifecycle.ready &&
      (
        await Promise.allSettled(this.contributors.map((check) => Promise.resolve().then(check)))
      ).every((result) => result.status === 'fulfilled' && result.value);
    // Volver a comprobar el estado tras la espera: el cierre puede haber comenzado entretanto.
    if (!available || !this.lifecycle.ready) {
      throw new ServiceUnavailableException({ status: 'unavailable', service: 'qapaq-secops-api' });
    }
    return { status: 'ok', service: 'qapaq-secops-api' };
  }
}
