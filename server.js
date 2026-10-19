import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const source = 'https://planzajec.wcy.wat.edu.pl/pl/rozklad';

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    return sendJson(response, 405, { error: 'Method not allowed' });
  }
  if (url.pathname === '/health') return sendJson(response, 200, { status: 'ok' });
  if (url.pathname !== '/api/schedule') return sendJson(response, 404, { error: 'Not found' });

  const group = url.searchParams.get('group') ?? '';
  if (!/^WCY[A-Za-z0-9_*]+$/.test(group))
    return sendJson(response, 400, { error: 'Valid WCY group is required' });

  const upstream = new URL(source);
  upstream.searchParams.set('grupa_id', group);
  try {
    const result = await fetch(upstream, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'WATplan server (schedule reader)',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) {
      return sendJson(response, result.status === 403 ? 502 : result.status, {
        error: 'Schedule source did not return a successful response',
        upstreamStatus: result.status,
      });
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await result.text());
  } catch (error) {
    sendJson(response, error?.name === 'TimeoutError' ? 504 : 502, {
      error: error?.name === 'TimeoutError' ? 'Schedule source timed out' : 'Could not reach schedule source',
    });
  }
});

server.listen(port, host, () => {
  console.log(`WATplan server listening on http://${host}:${port}`);
});
