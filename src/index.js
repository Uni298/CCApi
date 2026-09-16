// Cold Clear 2 API — Cloudflare Worker
//
// POST /suggest
//   body: { board, queue, hold?, combo?, back_to_back?, randomizer? }
//     board : 40行x10列の配列 (null | 'I'|'O'|'T'|'L'|'J'|'S'|'Z')  — TBP 形式
//     queue : これから流れるピース型の配列（現在のミノを先頭に含む）
//   → { type: "suggestion", moves: [...] , elapsedMs }
//
// GET /  |  GET /health  → { ok: true, engine: "coldclear2", ready }
//
// 認証: 環境変数/シークレット CC_API_TOKEN が設定されていれば
//   Authorization: Bearer <token> を要求する (wrangler secret put CC_API_TOKEN)。
import { cc2Engine } from "./cc2-glue.js";

const SEARCH_TIMEOUT = 3000; // 探索待ち上限(ms)。CC2内部はタイマーで細かく譲るため約0〜1s
const READY_WAIT = 15000;    // コールドスタート時の wasm 起動待ち上限(ms)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

// CC2 エンジンはシングルスレッドのため、リクエストを直列化する
let chain = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

async function runSuggest(input) {
  const eng = cc2Engine;
  if (!eng.isReady()) {
    await Promise.race([eng.ready.catch(() => null), sleep(READY_WAIT)]);
    if (!eng.isReady()) throw new Error('cc2 engine failed to boot');
  }
  eng.send({
    type: 'start',
    board: input.board,
    queue: input.queue,
    hold: input.hold || null,
    combo: Math.max(0, input.combo || 0),
    back_to_back: !!input.back_to_back,
    randomizer: { type: 'seven_bag', bag_state: [] },
  });
  // wasm-bindgen はイベントループに依存するため start と suggest の間を空ける
  await sleep(40);
  eng.send({ type: 'suggest' });

  const t0 = Date.now();
  while (Date.now() - t0 < SEARCH_TIMEOUT) {
    const sug = eng.takeSuggestion();
    if (sug) {
      return { type: 'suggestion', moves: sug.moves || [], elapsedMs: Date.now() - t0 };
    }
    await sleep(20);
  }
  throw new Error('search timeout');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ ok: true, engine: 'coldclear2', ready: cc2Engine.isReady() });
    }

    if (url.pathname !== '/suggest' || request.method !== 'POST') {
      return json({ error: 'not found' }, 404);
    }

    const token = env.CC_API_TOKEN;
    if (token) {
      const auth = request.headers.get('authorization') || '';
      if (auth !== 'Bearer ' + token) return json({ error: 'unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'bad json' }, 400);
    }
    if (!Array.isArray(body.board) || body.board.length !== 40) {
      return json({ error: 'board must be 40 rows' }, 400);
    }
    if (!Array.isArray(body.queue) || body.queue.length === 0) {
      return json({ error: 'queue required' }, 400);
    }

    const run = chain.then(() => runSuggest(body));
    chain = run.catch(() => {});
    try {
      return json(await run, 200);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};