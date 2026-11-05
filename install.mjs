// scripts/eye/install.mjs —— 页面内观察器的唯一一份源码
//
// watch.mjs 和 selftest.mjs 都从这里拿，避免两份漂移（copy of a copy 的老毛病）。
// 导出的是一个「表达式字符串」，在页面里 return 它即可。

export function installExpr(selector, sampleMs = 100) {
  return `(() => {
  if (window.__EYE) { window.__EYE.stop(); }
  const MAX = 4000;
  const ev = [];
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const push = (e) => { e.t = now(); ev.push(e); if (ev.length > MAX) ev.shift(); };
  const brief = (n) => {
    if (!n) return 'null';
    if (n.nodeType === 3) return '#text(' + JSON.stringify((n.textContent||'').trim().slice(0,40)) + ')';
    if (n.nodeType !== 1) return 'node' + n.nodeType;
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const cls = (n.className && typeof n.className === 'string') ? n.className.trim().split(/\\\\s+/).slice(0,3).join('.') : '';
    if (cls) s += '.' + cls;
    return s;
  };
  const watched = ${JSON.stringify(selector)}.split(',').map(s => s.trim()).filter(Boolean);

  // (1) DOM 增删 + 属性变化 —— 覆盖"没装通道"类
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) push({ k: 'DomAdd', p: brief(m.target), n: brief(n) });
        for (const n of m.removedNodes) push({ k: 'DomRemove', p: brief(m.target), n: brief(n) });
      } else if (m.type === 'attributes') {
        const v = m.target.getAttribute(m.attributeName);
        push({ k: 'Attr', p: brief(m.target), a: m.attributeName, v: String(v).slice(0, 60) });
      } else if (m.type === 'characterData') {
        push({ k: 'Text', p: brief(m.target.parentElement), v: (m.target.textContent||'').trim().slice(0,60) });
      }
    }
  });
  mo.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true,
    attributeFilter: ['style','class','hidden','disabled','aria-hidden','aria-expanded','aria-selected','data-state','open','checked','value','src','href']
  });

  // (2) 纯 CSS 展开（不发任何 DOM 事件）—— 只能靠页面内高频采样样式/布局
  let snap = new Map();
  const snapOf = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      d: cs.display, v: cs.visibility, o: cs.opacity,
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
      z: cs.zIndex, pe: cs.pointerEvents
    };
  };
  const key = (s) => [s.d,s.v,s.o,s.w,s.h,s.x,s.y].join('|');
  let timer = null;
  const sample = () => {
    for (const sel of watched) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      els.forEach((el, i) => {
        const id = sel + '#' + i;
        const s = snapOf(el);
        const prev = snap.get(id);
        if (prev && key(prev) !== key(s)) {
          const fields = ['d','v','o','w','h','x','y'].filter(f => String(prev[f]) !== String(s[f]));
          const delta = {};
          for (const f of fields) delta[f] = prev[f] + '->' + s[f];
          push({ k: 'Style', p: id, delta, text: (el.textContent||'').trim().slice(0,60) });
        }
        snap.set(id, s);
      });
    }
  };
  sample();
  if (watched.length && ${sampleMs} > 0) timer = setInterval(sample, ${sampleMs});

  window.__EYE = {
    t0: Date.now(),
    stop() { mo.disconnect(); if (timer) clearInterval(timer); },
    watched,
    sampleMs: ${sampleMs},
    dump(since, types) {
      since = since || 0;
      return ev.filter(e => e.t >= since && (!types || types.includes(e.k)));
    },
    counts() {
      const c = {};
      for (const e of ev) c[e.k] = (c[e.k]||0)+1;
      return c;
    },
    styleOf(sel) {
      const out = [];
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { return out; }
      els.forEach((el, i) => out.push(Object.assign({ i }, snapOf(el), {
        text: (el.textContent||'').trim().slice(0,80),
        cls: String(el.className||'').slice(0,80)
      })));
      return out;
    },
    hit(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const chain = [];
      let n = el;
      while (n && n.nodeType === 1 && chain.length < 6) { chain.push(brief(n)); n = n.parentElement; }
      return { top: brief(el), chain };
    },
    clear() { ev.length = 0; snap.clear(); sample(); }
  };
  return { ok: true, watched, sampleMs: ${sampleMs} };
})()`;
}
