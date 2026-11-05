// scripts/eye/watch.mjs —— 给我装眼睛：先录，事后再看
//
// 病根（notes/2026-11-05-perception-gap.md）：我的感知是拉取式的。
// 只在"操作完那一刻拍一张快照"，凡是闪一下就消失的东西全看不见。
// 这个工具改成"先装观察器 → 再动手 → 事后把这段时间线倒出来看"。
//
// 三类缺陷对应三种观察器（缺一不可）：
//   ① 没装通道      → MutationObserver (childList + subtree)：DomAdd / DomRemove
//   ② 通道装错      → 纯 CSS 展开不发 DOM 事件。解法：页面内 100ms 采样
//                     computedStyle + getBoundingClientRect，只采"指定的选择器"。
//                     （外挂轮询 1.5s 会漏；在页面里 100ms 才抓得住，且只抓关心的元素）
//   ③ 只有快照没录像 → 上面两条都是持续记录，等于录像；StyleChange 就是那一类
//
// 另外加一个 hitTest：document.elementFromPoint(x,y) 看点击那一刻谁在最上层。
// 专治"我点了但没反应"——通常是点在了遮罩/伪元素/别的兄弟节点上。
//
// 事件落点：页面内 window.__EYE.events（有上限的环形缓冲）。
// 不依赖 Node 进程活着，所以两次工具调用之间事件不丢。
//
// 用法：
//   node scripts/eye/watch.mjs start [--sel ".bcc-select,.bcc-select-list-wrap"] [--ms 100]
//   node scripts/eye/watch.mjs export [--since 0] [--types StyleChange,DomAdd] [--out 文件]
//   node scripts/eye/watch.mjs style --sel ".bcc-select"        # 打一份当前样式快照
//   node scripts/eye/watch.mjs style --sel "..." --diff          # 跟上次快照比
//   node scripts/eye/watch.mjs hit --x 100 --y 200              # 这点上到底是谁
//   node scripts/eye/watch.mjs clear
//
// 注意：ego 的 CDP 端口每次启动都变，一律从 browser.json 读（见 ./cdp.mjs）。

import { writeFileSync } from 'node:fs';
import { connect } from './cdp.mjs';
import { installExpr } from './install.mjs';
import { selFromPreset } from './presets.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

// --sel 既可以是选择器，也可以是预设名（bilibili-submit 或 bilibili-submit:分组）
const SEL = selFromPreset(opt('sel', '').trim());
const SAMPLE_MS = Number(opt('ms', 100));

// ── 输出格式化：给人读的时间线，不是 JSON 墙 ─────────────────────
const fmt = (ev) => {
  const pad = (n) => String(n).padStart(6, ' ');
  switch (ev.k) {
    case 'DomAdd': return `${pad(ev.t)}ms  ＋出现  ${ev.n}  ∈  ${ev.p}`;
    case 'DomRemove': return `${pad(ev.t)}ms  －消失  ${ev.n}  ∈  ${ev.p}`;
    case 'Attr': return `${pad(ev.t)}ms  ~属性  ${ev.p}  ${ev.a} = ${ev.v}`;
    case 'Text': return `${pad(ev.t)}ms  ~文字  ${ev.p}  "${ev.v}"`;
    case 'Style': return `${pad(ev.t)}ms  ~样式  ${ev.p}  ${Object.entries(ev.delta || {}).map(([k, v]) => k + ' ' + v).join(', ')}  ${ev.text ? '"' + ev.text + '"' : ''}`;
    default: return `${pad(ev.t)}ms  ${ev.k}  ${JSON.stringify(ev)}`;
  }
};

// body 是一段函数体，自己写 return。
const evalIn = async (cdp, body) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
};

const needEye = `if (!window.__EYE) throw new Error('还没装眼睛 —— 先跑 watch.mjs start');`;

const main = async () => {
  const cdp = await connect();
  if (!cmd || cmd === 'help') {
    console.log('用法: node scripts/eye/watch.mjs start|export|style|hit|clear|status ...');
    cdp.close(); return;
  }

  if (cmd === 'start') {
    const r = await evalIn(cdp, `return ${installExpr(SEL, SAMPLE_MS)};`);
    console.log('眼睛已装上:', cdp.page.url.slice(0, 70));
    console.log('  监听选择器:', r.watched.length ? r.watched.join(' , ') : '(无 —— Style 类不会工作，加 --sel)');
    console.log('  采样间隔:', r.sampleMs + 'ms');
    console.log('下一步：去做你的操作，然后 node scripts/eye/watch.mjs export');
    cdp.close(); return;
  }

  if (cmd === 'status') {
    const r = await evalIn(cdp, `${needEye}
return { url: location.href, watched: __EYE.watched, sampleMs: __EYE.sampleMs, counts: __EYE.counts() };`);
    console.log('页面:', cdp.page.url.slice(0, 70));
    console.log('选择器:', r.watched.join(' , ') || '(无)');
    console.log('事件数:', JSON.stringify(r.counts));
    cdp.close(); return;
  }

  if (cmd === 'clear') {
    const r = await evalIn(cdp, `${needEye}
__EYE.clear(); return __EYE.counts();`);
    console.log('已清空，当前:', JSON.stringify(r));
    cdp.close(); return;
  }

  if (cmd === 'export') {
    const since = Number(opt('since', 0));
    const types = opt('types', '') ? opt('types').split(',').map((s) => s.trim()) : null;
    const evs = await evalIn(cdp, `${needEye}
return __EYE.dump(${since}, ${JSON.stringify(types)});`);
    if (!Array.isArray(evs) || !evs.length) {
      console.log('这段时间**什么都没发生**（这本身是重要信息：要么真的没变化，要么选择器没覆盖到）');
      cdp.close(); return;
    }
    const lines = evs.map(fmt);
    const head = `# 时间线 · ${cdp.page.url}\n# ${evs.length} 条事件 · 0 表示装眼睛那一刻\n`;
    const text = head + lines.join('\n') + '\n';
    const out = opt('out', '');
    if (out) { writeFileSync(out, text, 'utf8'); console.log(`已导出 ${evs.length} 条 -> ${out}`); }
    else console.log(text);
    cdp.close(); return;
  }

  if (cmd === 'style') {
    if (!SEL) throw new Error('style 需要 --sel');
    const r = await evalIn(cdp, `${needEye}
return __EYE.styleOf(${JSON.stringify(SEL)});`);
    const out = opt('out', '');
    const text = JSON.stringify(r, null, 2);
    if (out) writeFileSync(out, text, 'utf8');
    else console.log(text);
    if (flag('diff')) {
      // 与同目录上一份快照比
      const { readFileSync, existsSync } = await import('node:fs');
      const prevPath = out ? out.replace(/\.json$/, '.prev.json') : '';
      if (prevPath && existsSync(prevPath)) {
        const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
        const cur = r;
        const diffs = [];
        const n = Math.max(prev.length, cur.length);
        for (let i = 0; i < n; i++) {
          const a = prev[i], b = cur[i];
          if (!a) { diffs.push(`#${i} 新出现 ${JSON.stringify(b)}`); continue; }
          if (!b) { diffs.push(`#${i} 消失 (原 ${a.d}/${a.w}x${a.h})`); continue; }
          const ch = ['d','v','o','w','h','x','y','pe','z'].filter((f) => String(a[f]) !== String(b[f]))
            .map((f) => `${f} ${a[f]} -> ${b[f]}`);
          if (ch.length) diffs.push(`#${i} ${ch.join(', ')}`);
        }
        console.log(diffs.length ? '样式差异:\n  ' + diffs.join('\n  ') : '样式无差异');
      } else if (prevPath) {
        console.log(`（没有上一份快照：${prevPath} 不存在；这次跑完后会把当前存为 .prev.json）`);
        writeFileSync(prevPath, JSON.stringify(r), 'utf8');
      }
    }
    cdp.close(); return;
  }

  if (cmd === 'hit') {
    const x = Number(opt('x', '0')), y = Number(opt('y', '0'));
    const r = await evalIn(cdp, `${needEye}
return __EYE.hit(${x}, ${y});`);
    console.log(JSON.stringify(r, null, 2));
    cdp.close(); return;
  }

  throw new Error('未知子命令: ' + cmd);
};

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
