// A local stand-in for the Vercel deployment: the same /api handlers on http://localhost:3000, with the data in memory
// (or in Upstash when its variables are set). For trying the apps against it; not for real use.
//   LILAC_PASSWORD=비밀번호 node dev.js
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { memoryStore, redisStore } from './lib/store.js';
import { passwordOf } from './lib/auth.js';
import { statusHandler } from './api/status.js';
import { loginHandler } from './api/login.js';
import { syncHandler } from './api/sync.js';

const context = { store: redisStore() || memoryStore(), password: passwordOf() };
const routes = { '/api/status': statusHandler(context), '/api/login': loginHandler(context), '/api/sync': syncHandler(context) };
const port = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (path === '/' && req.method === 'GET') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(readFileSync(new URL('./public/index.html', import.meta.url))); }
  const handler = routes[path];
  if (handler) return handler(req, res);
  res.statusCode = 404; res.end('Not found');
}).listen(port, () => console.log(`LilacAnime server on http://localhost:${port}${context.password ? '' : ' (LILAC_PASSWORD is not set)'}`));
