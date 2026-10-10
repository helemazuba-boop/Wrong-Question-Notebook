import { createServer } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

const certificates = new URL('../../../.ci-local/certs/', import.meta.url);
const tls = {
  key: readFileSync(new URL('server.key', certificates)),
  cert: readFileSync(new URL('server.crt', certificates)),
};
for (const [port, upstream] of [
  [8443, 3000],
  [8444, 54321],
]) {
  const server = createServer(tls, (req, res) => {
    const proxy = request(
      {
        host: '127.0.0.1',
        port: upstream,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          'x-forwarded-host': req.headers.host,
          'x-forwarded-proto': 'https',
        },
      },
      response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    );
    proxy.on('error', error => {
      console.error(`Gateway upstream ${upstream}: ${error.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end('Test upstream unavailable');
    });
    req.pipe(proxy);
  });
  server.on('upgrade', (req, socket, head) => {
    const proxy = connect(upstream, '127.0.0.1', () => {
      proxy.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        proxy.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      proxy.write('\r\n');
      if (head.length) proxy.write(head);
      socket.pipe(proxy).pipe(socket);
    });
    proxy.on('error', () => socket.destroy());
    socket.on('error', () => proxy.destroy());
  });
  server.listen(port, '0.0.0.0', () =>
    console.log(`Test HTTPS gateway listening on ${port}`)
  );
}
