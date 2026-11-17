import { describe, expect, it, vi } from 'vitest';
import type { AssistantTool } from '@qapaq/assistant';

import {
  QAPAQ_MCP_PROTOCOL_VERSION,
  connectMcpInProcess,
  dispatchMcpRequest,
} from '../src/assistant/mcp-protocol.js';

function tool(run = vi.fn(async () => ({ ok: true as const, data: { safe: true } }))): AssistantTool {
  return {
    name: 'list_alerts',
    label: 'Listar alertas',
    description: 'Lista alertas permitidas.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run,
  };
}

describe('MCP stateless Streamable HTTP dispatcher', () => {
  it('completa initialize en la revisiÃ³n soportada y rechaza otra revisiÃ³n', async () => {
    await expect(
      dispatchMcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: QAPAQ_MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        },
        [],
      ),
    ).resolves.toMatchObject({ result: { protocolVersion: QAPAQ_MCP_PROTOCOL_VERSION, capabilities: { tools: {} } } });
    await expect(
      dispatchMcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 'future', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
        },
        [],
      ),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it('publica las herramientas permitidas en orden determinista con anotaciÃ³n de solo lectura', async () => {
    const result = await dispatchMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, [
      { ...tool(), name: 'z_tool' },
      tool(),
    ]);
    expect(result).toMatchObject({
      result: {
        tools: [
          { name: 'list_alerts', annotations: { readOnlyHint: true, destructiveHint: false } },
          { name: 'z_tool' },
        ],
      },
    });
  });

  it('conecta el bucle de Qapaqzito por initialize, tools/list y tools/call MCP', async () => {
    const handlers = [tool(vi.fn(async (input) => ({ ok: true as const, data: input })))];
    const clientTools = await connectMcpInProcess(handlers);
    expect(clientTools.map((entry) => entry.name)).toEqual(['list_alerts']);
    await expect(clientTools[0]?.run({ pageSize: 2 })).resolves.toEqual({
      ok: true,
      data: { pageSize: 2 },
    });
  });

  it('ejecuta solo una herramienta expuesta y no permite despachar herramientas de escritura desconocidas', async () => {
    const run = vi.fn(async (input) => ({ ok: true as const, data: input }));
    const allowed = tool(run);
    await expect(
      dispatchMcpRequest(
        { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'list_alerts', arguments: { pageSize: 3 } } },
        [allowed],
      ),
    ).resolves.toMatchObject({ result: { content: [{ type: 'text', text: '{"pageSize":3}' }] } });
    await expect(
      dispatchMcpRequest(
        { jsonrpc: '2.0', id: 'deny', method: 'tools/call', params: { name: 'isolate_endpoint' } },
        [allowed],
      ),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('seudonimiza PII y elimina credenciales en respuestas del endpoint MCP', async () => {
    const privateData: AssistantTool = {
      ...tool(),
      run: async () => ({
        ok: true,
        data: { email: 'analista@example.com', ip: '10.20.30.40', token: 'ghp_123456789012345678901234' },
      }),
    };
    const reply = await dispatchMcpRequest(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_alerts' } },
      [privateData],
    );
    expect(reply).toMatchObject({
      result: { content: [{ text: '{"email":"<usuario_1>","ip":"<ip_1>","token":"[REDACTED]"}' }] },
    });
  });

  it('maneja fallos de herramienta como isError, notificaciones sin respuesta y mÃ©todos desconocidos', async () => {
    const failed: AssistantTool = {
      ...tool(),
      run: async () => ({ ok: false, error: 'Consulta no disponible' }),
    };
    await expect(
      dispatchMcpRequest(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_alerts' } },
        [failed],
      ),
    ).resolves.toMatchObject({ result: { isError: true } });
    await expect(
      dispatchMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, []),
    ).resolves.toBeNull();
    await expect(
      dispatchMcpRequest({ jsonrpc: '2.0', id: 4, method: 'unknown' }, []),
    ).resolves.toMatchObject({ error: { code: -32601 } });
    const throws: AssistantTool = { ...tool(), run: async () => { throw new Error('sensitive internal detail'); } };
    await expect(
      dispatchMcpRequest(
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_alerts' } },
        [throws],
      ),
    ).resolves.toMatchObject({ result: { isError: true, content: [{ text: '{"error":"La herramienta no pudo completar la consulta."}' }] } });
  });
});
