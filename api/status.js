import { handleErrors, cors, send, setup, problems, VERSION } from '../lib/http.js';

// GET /api/status: whether this is a LilacAnime server and whether it is set up. No sign-in needed (it tells nothing
// about the data), so an app can check an address before asking for the password.
export function statusHandler(context) {
  return handleErrors(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method !== 'GET') return send(res, 405, { error: 'GET만 지원합니다.' });
    const config = setup(context), list = problems(config);
    if (!list.length && config.store.ping) {
      try { if (!await config.store.ping()) throw new Error('Redis ping failed'); }
      catch { list.push('Upstash Redis에 연결하지 못했습니다. Redis URL·토큰 환경 변수와 데이터베이스 상태를 확인하고 다시 배포하세요.'); }
    }
    return send(res, 200, { app: 'lilacanime-server', version: VERSION, ready: !list.length, problems: list });
  });
}

export default statusHandler();
