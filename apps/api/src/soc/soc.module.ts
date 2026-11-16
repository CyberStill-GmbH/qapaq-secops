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
import { MePushController } from './me-push.controller.js';
import { IncidentWorkController } from './incident-work.controller.js';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { AssistantController } from '../assistant/assistant.controller.js';
import { AssistantMcpController } from '../assistant/mcp.controller.js';
import { AiInvestigationsController } from '../assistant/ai-investigations.controller.js';
import { CorrelatorController } from './correlator.controller.js';
import { RiskController } from './risk.controller.js';
import { LocalAuthController } from './local-auth.controller.js';
import { NotificationChannelsController } from './notification-channels.controller.js';
import { OperationsController } from './operations.controller.js';
import { SocController } from './soc.controller.js';
import { WazuhPushController } from './wazuh-push.controller.js';
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
        // Antes que OperationsController: `notifications/channels` no debe caer en `notifications/:id`.
        NotificationChannelsController,
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
        AssistantMcpController,
        AiInvestigationsController,
        CorrelatorController,
        RiskController,
        ...(runtime.canAcceptWazuhPush ? [WazuhPushController] : []),
        // Las rutas del emisor local solo se registran cuando ese emisor existe.
        ...(runtime.isLocalIdentity ? [LocalAuthController] : []),
      ],
      providers: [{ provide: SECOPS_RUNTIME, useValue: runtime }],
    };
  }
}
