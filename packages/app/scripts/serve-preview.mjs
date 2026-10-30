// Serves the extension folder so webview/dev.html can load ../dist/* (npm run preview).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 5178);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // The page's relative links (desktop-theme.css) need its own folder in the address.
  if (url.pathname === '/') {
    res.writeHead(302, { location: `/webview/dev.html${url.search}` }).end();
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Webview preview: http://localhost:${port}/`));
