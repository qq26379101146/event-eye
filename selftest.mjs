// scripts/eye/selftest.mjs —— 验"眼睛真的能看见"
//
// 为什么要这个：watch.mjs 是会改的工具。改完如果只靠肉眼跑一遍，
// 下次改坏了看不出来。这个脚本跑对照实验，三类各断言一次，任一失败就 exit 1。
//
// 三类（见 notes/2026-11-05-perception-gap.md）：
//   ① 一闪过的事件       提示条 0.8s       -> 必须抓到 DomAdd + DomRemove
//   ② 纯 CSS 展开        二级菜单 hover    -> 必须抓到 Style(d none->block)
//   ③ 快照 vs 录像       弹窗 2s           -> 必须抓到 DomAdd + DomRemove
//
// 用法：node scripts/eye/selftest.mjs
// 需要 ego 浏览器在跑（ego_space_open）。脚本自己导航到测试页，不碰用户的页面。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { connect, readBrowserEndpoint } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const TEST_PAGE = join(root, 'scratch', '2026-11-05-eye-test', 'page.html');
const OUT = join(root, 'scratch', '2026-11-05-eye-test');

if (!existsSync(TEST_PAGE)) {
  console.error(`找不到测试页 ${TEST_PAGE}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [], fail = [];
const check = (name, ok, detail = '') => (ok ? pass : fail).push({ name, detail });

// 与 watch.mjs start 相同的注入逻辑（保持一份，避免两处漂移靠 include 不够稳）
import { installExpr } from './install.mjs';

const evalIn = async (cdp, body) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
};

const main = async () => {
  const ep = readBrowserEndpoint();
  console.log('浏览器', ep.httpBase, 'pid=' + ep.pid);

  // 自己开一个 tab，不动用户正在用的页面
  const ws0 = new WebSocket(ep.wsUrl);
  await new Promise((res, rej) => { ws0.onopen = res; ws0.onerror = () => rej(new Error('ws 连接失败')); });
  let id = 0;
  const send0 = (method, params = {}) => new Promise((res, rej) => {
    const m = { id: ++id, method, params };
    ws0.send(JSON.stringify(m));
    ws0.onmessage = (e) => {
      const x = JSON.parse(e.data);
      if (x.id === m.id) x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result);
    };
  });
  const { targetId } = await send0('Target.createTarget', { url: 'about:blank' });
  ws0.close();

  const cdp = await connect({ targetId });
  console.log('测试页:', TEST_PAGE);

  // 导航
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'file:///' + TEST_PAGE.replace(/\\/g, '/').replace(/^\/+/, '') });
  await sleep(800);

  // 装眼睛：三类全覆盖
  const inst = await evalIn(cdp, `return ${installExpr('#cssSub,.modal-mask,.modal-box,#toastHost', 100)};`);
  check('装眼睛', inst && inst.ok, JSON.stringify(inst && inst.watched));

  // ── ① 提示条：只活 0.8 秒
  await evalIn(cdp, `window.__toast(); return 1;`);
  await sleep(900);
  let evs = await evalIn(cdp, `return __EYE.dump(0);`);
  const toastAdd = evs.some((e) => e.k === 'DomAdd' && /__toast/.test(e.n));
  const toastRm = evs.some((e) => e.k === 'DomRemove' && /__toast/.test(e.n));
  check('① 0.8s 提示条出现', toastAdd, toastAdd ? '' : '没抓到 DomAdd');
  check('① 0.8s 提示条消失', toastRm, toastRm ? '' : '没抓到 DomRemove');

  // ── ③ 弹窗：插入 2 秒再移除
  await evalIn(cdp, `window.__openModal(); return 1;`);
  await sleep(500);
  const midModal = await evalIn(cdp, `return __EYE.dump(0);`);
  check('③ 弹窗插入可见', midModal.some((e) => e.k === 'DomAdd' && /modal-mask/.test(e.n)), '');
  await sleep(1800);
  await evalIn(cdp, `window.__closeModal(); return 1;`);
  await sleep(300);
  evs = await evalIn(cdp, `return __EYE.dump(0);`);
  check('③ 弹窗移除', evs.some((e) => e.k === 'DomRemove' && /modal-mask/.test(e.n)), '');

  // ── ② 纯 CSS 二级菜单：这一条最要命 —— 监听事件根本听不到
  // 用 CDP 派发真实鼠标移动，触发 :hover
  // getBoundingClientRect 直接 return 会被序列化成 {}，必须自己 JSON.stringify
  const rect = JSON.parse(await evalIn(cdp, `return JSON.stringify(document.getElementById('navBar').getBoundingClientRect());`));
  const cx = Math.round(Number(rect.x) + Number(rect.width) / 2), cy = Math.round(Number(rect.y) + Number(rect.height) / 2);
  await evalIn(cdp, `__EYE.clear(); return 1;`);  // 只留 hover 这一段，断言更干净
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
  await sleep(400);
  const onHover = await evalIn(cdp, `return __EYE.dump(0);`);
  const opened = onHover.some((e) => e.k === 'Style' && String(e.delta && e.delta.d || '').includes('none->block'));
  check('② CSS 菜单展开(d none->block)', opened, onHover.length ? `只看到 ${onHover.map(e=>e.k).join(',')}` : '0 条事件');

  // 移开，确认能录到收起
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 400, y: cy + 300 });
  await sleep(400);
  const after = await evalIn(cdp, `return __EYE.dump(0);`);
  check('② CSS 菜单收起(block->none)', after.some((e) => e.k === 'Style' && String(e.delta && e.delta.d || '').includes('block->none')), '');

  // ── hitTest：这个点最上层是谁
  await sleep(200);
  const hitAtNav = await evalIn(cdp, `return __EYE.hit(${cx}, ${cy});`);
  check('hitTest 返回顶层元素', hitAtNav && /nav/.test(hitAtNav.top), JSON.stringify(hitAtNav && hitAtNav.top));

  // ── 导出完整时间线，留证据
  const all = await evalIn(cdp, `return __EYE.dump(0);`);
  const lines = all.map((e) => `${String(e.t).padStart(6, ' ')}ms  ${e.k}  ${e.p || ''}  ${e.n || ''} ${e.delta ? JSON.stringify(e.delta) : ''}`);
  writeFileSyncChecked(join(OUT, 'selftest-timeline.txt'),
    `# selftest ${new Date().toISOString()}\n# ${all.length} 条\n` + lines.join('\n') + '\n');

  // 收尾：关掉自己开的 tab
  await cdp.send('Target.closeTarget', { targetId });
  cdp.close();

  // ── 汇总
  console.log('\n─── selftest ───');
  for (const p of pass) console.log('PASS  ' + p.name);
  for (const f of fail) console.log('FAIL  ' + f.name + (f.detail ? '  ← ' + f.detail : ''));
  console.log(`\n${pass.length} 过 / ${fail.length} 败`);
  console.log(`时间线留证: ${join(OUT, 'selftest-timeline.txt')}`);
  process.exit(fail.length ? 1 : 0);
};

const writeFileSyncChecked = (p, text) => {
  try { readFileSync(p, 'utf8'); } catch { /* 新文件也行 */ }
  const { writeFileSync } = importsFs;
  writeFileSync(p, text, 'utf8');
};
const importsFs = await import('node:fs');

main().catch((e) => { console.error('selftest 崩了:', e.message); process.exit(1); });
