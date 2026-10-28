/**
 * Módulo del BFF. El runtime se construye fuera y se inyecta: el composition root
 * decide qué adapters usa cada perfil, y los controladores no conocen ninguno.
 */

import { Module, type DynamicModule } from '@nestjs/common';

import { AdminRoleGrantsController } from './admin-role-grants.controller.js';
import { AdminSessionsController } from './admin-sessions.controller.js';
import { ChangesController } from './changes.controller.js';
import { EventsController } from './events.controller.js';
import { SourcesHealthController } from './sources-health.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AssistantController } from './assistant.controller.js';
import { MePushController } from './me-push.controller.js';
import { IncidentWorkController } from './incident-work.controller.js';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { LocalAuthController } from './local-auth.controller.js';
import { OperationsController } from './operations.controller.js';
import { SocController } from './soc.controller.js';
import { SECOPS_RUNTIME } from './tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';

@Module({})
export class SocModule {
  public static compose(runtime: SecOpsRuntime): DynamicModule {
    return {
      module: SocModule,
      controllers: [
        AuthController,
        SocController,
        AuditController,
        OperationsController,
        AdminSessionsController,
        IncidentWorkController,
        ChangesController,
        EventsController,
        SourcesHealthController,
        AdminUsersController,
        AdminRoleGrantsController,
        MePushController,
        AssistantController,
        // Las rutas del emisor local solo se registran cuando ese emisor existe.
        ...(runtime.isLocalIdentity ? [LocalAuthController] : []),
      ],
      providers: [{ provide: SECOPS_RUNTIME, useValue: runtime }],
    };
  }
}
