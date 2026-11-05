// eye/cdp.mjs —— 连到 ego 浏览器的 CDP 底座（端口自动发现，不写死）
//
// 为什么不要写死端口：ego 每次启动都换端口（本轮是 50778，上一轮 64616 已失效）。
// 权威来源是 %LOCALAPPDATA%\ego-lite-linux\browser.json 里的 port 字段。
//
// 用法（作为库）：
//   import { connect } from './cdp.mjs';
//   const cdp = await connect();            // 连第一个 page target
//   await cdp.send('Runtime.enable');
//
// 用法（直接跑，自检）：
//   node scripts/eye/cdp.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR =
  process.env.EGO_STATE_DIR ||
  join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ego-lite-linux');

/** 从 browser.json 读当前 CDP 端口/wsUrl。读不到就报清楚的错，别猜端口。 */
export function readBrowserEndpoint() {
  const p = join(STATE_DIR, 'browser.json');
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`读不到 ${p} —— ego 浏览器没在跑？用 ego_space_open 先拉起。( ${e.code} )`);
  }
  const j = JSON.parse(raw);
  if (!j.port && !j.wsUrl) throw new Error(`${p} 里既没有 port 也没有 wsUrl`);
  return { ...j, httpBase: j.wsUrl ? j.wsUrl.replace(/^ws/, 'http').split('/devtools/')[0] : `http://127.0.0.1:${j.port}` };
}

/** 列出当前所有 page target。 */
export async function listPages(httpBase) {
  const r = await fetch(`${httpBase}/json/list`);
  if (!r.ok) throw new Error(`GET ${httpBase}/json/list -> HTTP ${r.status}`);
  return (await r.json()).filter((t) => t.type === 'page');
}

/**
 * 连上浏览器级 ws，并 attach 到某个 page target。
 * 返回一个简易 CDP 客户端：{ send, on, close, sessionId, target }。
 */
export async function connect({ targetId, pageFilter } = {}) {
  const ep = readBrowserEndpoint();
  const pages = await listPages(ep.httpBase);
  const page =
    (targetId && pages.find((p) => p.id === targetId)) ||
    (pageFilter && pages.find((p) => pageFilter(p))) ||
    pages[0];
  if (!page) throw new Error('没有可用的 page target');

  const ws = new WebSocket(ep.wsUrl || `ws://127.0.0.1:${ep.port}/devtools/browser/${''}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP ws 连接失败'));
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map(); // method -> [fn]

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method) {
      for (const fn of listeners.get(m.method) || []) {
        try { fn(m.params, m.sessionId); } catch { /* listener 出错不影响通道 */ }
      }
      for (const fn of listeners.get('*') || []) {
        try { fn(m); } catch {}
      }
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(msg.id, { res, rej });
      ws.send(JSON.stringify(msg));
    });

  const { sessionId } = await send('Target.attachToTarget', { targetId: page.id, flatten: true });

  return {
    ep,
    page,
    sessionId,
    send: (method, params, sid) => send(method, params, sid || sessionId),
    on: (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

// ── 自检 ────────────────────────────────────────────────────────────
if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('cdp.mjs'))) {
  const ep = readBrowserEndpoint();
  console.log('browser.json:', ep.httpBase, 'pid=' + ep.pid, 'headless=' + ep.headless);
  const pages = await listPages(ep.httpBase);
  console.log('page targets:', pages.length);
  for (const p of pages) console.log('  ', p.id.slice(0, 8), '|', p.title.slice(0, 40), '|', p.url.slice(0, 60));
  const cdp = await connect();
  console.log('attached ✓', cdp.page.title.slice(0, 40));
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({url:location.href,title:document.title})',
    returnByValue: true,
  });
  console.log('eval ok:', result.value);
  cdp.close();
  process.exit(0);
}
