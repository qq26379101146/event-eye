// 验证：CDP 直连 ego 浏览器，注入观察器，能不能收到推送
const V = await (await fetch('http://127.0.0.1:64616/json/version')).json();
console.log('browser ws:', V.webSocketDebuggerUrl.slice(0, 60));
const ws = new WebSocket(V.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const m = { id: ++id, method, params }; if (sessionId) m.sessionId = sessionId;
  pending.set(m.id, { res, rej }); ws.send(JSON.stringify(m));
});
const got = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Runtime.bindingCalled') got.push(m.params);
};
await new Promise(r => ws.onopen = r);
console.log('ws open ✓');
const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find(t => t.type === 'page');
console.log('page:', page.title.slice(0, 30));
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
console.log('attached ✓', sessionId.slice(0, 8));
await send('Runtime.enable', {}, sessionId);
await send('Runtime.addBinding', { name: '__EYE_PUSH' }, sessionId);
console.log('binding ok');
await send('Runtime.evaluate', { expression: "window.__EYE_PUSH(JSON.stringify({kind:'probe',t:Date.now()}))" }, sessionId);
await new Promise(r => setTimeout(r, 300));
console.log('bindingCalled 收到:', got.length, JSON.stringify(got[0]?.payload));
ws.close(); process.exit(0);
