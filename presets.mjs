// scripts/eye/presets.mjs —— 把 presets/*.json 变成 --sel 字符串
//
// 为什么要：B 站投稿页那些选择器（.bcc-select / 真上传控件 / 错误提示）很长，
// 每次手敲必然敲错或漏。存一份，用名字引用。
//
// 用法：
//   import { selFromPreset } from './presets.mjs';
//   const sel = selFromPreset('bilibili-submit', 'full');       // 全部
//   const sel = selFromPreset('bilibili-submit', '声明+提示');   // 只几条
//
// 命令行：
//   node scripts/eye/presets.mjs list
//   node scripts/eye/presets.mjs show bilibili-submit full

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'presets');

export function listPresets() {
  try {
    return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function loadPreset(name) {
  const p = join(DIR, `${name}.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * selector 字符串：preset 名可以是 "bilibili-submit" 或 "bilibili-submit:full"。
 * 认不出来就原样返回（当作普通选择器），不阻断。
 */
export function selFromPreset(name, which = 'full') {
  if (!name) return '';
  // name 允许两种写法：'bilibili-submit'(全部) 或 'bilibili-submit:声明+提示'(指定分组)
  // which 也可以指定分组；name 里带冒号时以 name 为准。
  const [presetName, groupInName] = name.split(':');
  if (!listPresets().includes(presetName)) return name; // 不是预设名 -> 当普通选择器

  const p = loadPreset(presetName);
  const all = new Map(p.selectors.map((s) => [s.key, s.sel]));

  const group = groupInName || (which !== 'full' ? which : null);
  let keys;
  if (group) {
    if (p.groups && p.groups[group]) keys = p.groups[group];       // 具名分组（推荐）
    else keys = group.split('+').map((k) => k.trim()).filter(Boolean);  // 临时点几项
  } else {
    keys = [...all.keys()];
  }
  const picked = [];
  for (const k of keys) {
    if (all.has(k)) picked.push(all.get(k));
    else process.stderr.write(`[warn] 预设 ${presetName} 里没有 "${k}"，跳过\n`);
  }
  return picked.join(',');
}

if (process.argv[1] && process.argv[1].endsWith('presets.mjs')) {
  const [, , cmd, a, b] = process.argv;
  if (!cmd || cmd === 'list') {
    for (const n of listPresets()) {
      const p = loadPreset(n);
      console.log(`${n}  — ${p.desc || ''}`);
      console.log(`   ${p.selectors.length} 条选择器，分组: ${Object.keys(p.presets || {}).join(' / ') || '(无)'}`);
    }
  } else if (cmd === 'show') {
    const p = loadPreset(a);
    const which = b || 'full';
    console.log(selFromPreset(a, which));
    console.log();
    for (const s of p.selectors) console.log(`  ${s.key.padEnd(14)} ${s.sel}`);
  } else {
    console.error('用法: node scripts/eye/presets.mjs list | show <name> [分组]');
  }
}
