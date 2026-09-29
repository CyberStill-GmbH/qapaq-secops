import { createServer } from 'node:http';

const server = createServer(async (request, response) => {
  if (request.url === '/' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}');
    return;
  }
  if (request.headers.authorization !== 'Basic dGVzdDp0ZXN0') {
    response
      .writeHead(401, { 'content-type': 'application/json' })
      .end('{"error":"backend authentication missing"}');
    return;
  }
  if (request.url === '/_cluster/health') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-internal-topology': 'test-indexer',
    });
    response.end('{"cluster_name":"test","status":"green"}');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/wazuh-alerts-*/_search') {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request"}');
    return;
  }
  const status = body.controlStatus;
  if (status === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (status === 'reset') {
    response.socket.destroy();
    return;
  }
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    response.writeHead(status, {
      'content-type': 'application/json',
      'x-internal-topology': 'test-indexer',
    });
    response.end(JSON.stringify({ error: `controlled-${status}` }));
    return;
  }
  const adapterProbe = body?.query?.range?.timestamp;
  response.writeHead(200, {
    'content-type': 'application/json',
    'x-internal-topology': 'test-indexer',
  });
  response.end(
    adapterProbe
      ? JSON.stringify({
          took: 1,
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'c10-gateway-proof',
                _source: {
                  timestamp: '2026-09-28T12:00:00.000Z',
                  id: 'c10-gateway-proof',
                  rule: { id: '1001', level: 12 },
                },
                sort: ['2026-09-28T12:00:00.000Z', 'c10-gateway-proof'],
              },
            ],
          },
        })
      : '{"took":1,"hits":{"total":{"value":0},"hits":[]}}',
  );
});

server.listen(9200, '0.0.0.0');
