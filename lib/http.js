import { redisStore } from './store.js';
import { passwordOf } from './auth.js';

export const VERSION = 1;

// Apps call the server from anywhere (and a token, not a cookie, signs them in), so any origin may ask.
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

export function send(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(status === 204 ? undefined : JSON.stringify(body)); }

// Vercel parses a JSON body into req.body; a local server may hand over the raw text.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export async function bodyOf(req) {
  const tooLarge = () => Object.assign(new Error('요청 본문은 4MB 이하여야 합니다.'), { status: 413 });
  if (req.body !== undefined && !Buffer.isBuffer(req.body)) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw tooLarge();
    return JSON.parse(text || '{}');
  }
  const chunks = []; let size = 0;
  for await (const chunk of req.body ? [req.body] : req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Vercel otherwise turns rejected store requests into an HTML 500 response.
export function handleErrors(handler) {
  return async (req, res) => {
    try { return await handler(req, res); }
    catch { return send(res, 503, { error: '저장소에 연결하지 못했습니다. Upstash 연결 상태를 확인한 뒤 다시 시도하세요.' }); }
  };
}

// What the handlers need, taken from the environment unless a test hands it over.
export function setup(context = {}) {
  const env = context.env || process.env;
  return { password: context.password !== undefined ? context.password : passwordOf(env), store: context.store !== undefined ? context.store : redisStore(env) };
}

// The problems that keep the server from working, said the way the owner fixes them.
export function problems({ password, store }) {
  const list = [];
  if (!password) list.push('Vercel 프로젝트 환경 변수 LILAC_PASSWORD(8자 이상)를 설정하고 다시 배포하세요.');
  if (!store) list.push('Vercel 프로젝트에 Upstash Redis(Storage 탭)를 연결하고 다시 배포하세요.');
  return list;
}

export function clientAddress(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim(); }
