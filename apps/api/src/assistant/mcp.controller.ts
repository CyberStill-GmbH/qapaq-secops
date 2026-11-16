import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest, OutgoingReply } from '../http/http-contracts.js';
import { mutatingActor } from '../soc/session-actor.js';
import { SECOPS_RUNTIME } from '../soc/tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import { createInternalGet } from './internal-client.js';
import { dispatchMcpRequest } from './mcp-protocol.js';
import { buildSocTools } from './soc-tools.js';
import { startInvestigationAction } from './analyst-tools.js';

const READ_CAPABILITIES = [
  'alerts.read',
  'incidents.read',
  'events.read',
  'sources.health.read',
  'notifications.read',
  'audit.read',
  'observability.read_soc',
  'users.read',
  'investigations.read',
] as const;

@Controller('api/assistant')
export class AssistantMcpController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  /** MCP Streamable HTTP stateless endpoint. QAPAQ session, CSRF and per-request capabilities apply. */
  @Post('mcp')
  @HttpCode(200)
  public async handle(
    @Req() request: IncomingRequest,
    @Body() body: unknown,
    @Res() response: OutgoingReply,
  ) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    if (!this.runtime.assistant || !READ_CAPABILITIES.some((cap) => actor.capabilities.has(cap))) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    if (!this.runtime.internalServer) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    const startInvestigation = startInvestigationAction(this.runtime, actor, correlationId, 'mcp');
    const tools = buildSocTools(
      createInternalGet(this.runtime.internalServer, request),
      { roles: actor.roles, capabilities: [...actor.capabilities] },
      startInvestigation ? { startInvestigation } : {},
    );
    const result = await dispatchMcpRequest(body, tools);
    if (result === null) {
      response.status(202).send();
      return;
    }
    response.header('content-type', 'application/json').send(result);
  }
}
