# event-eye · 别在操作完之后才"看一眼"

> 给 AI agent（或者任何用 CDP 驱动浏览器的人）装一只**录像式**的眼睛。

## 问题：快照式感知有三类盲区

用 `Page.captureSnapshot` / `getBoundingClientRect` 这类**拉取**手段看页面，只能看见"我去取的那一刻"。
凡是这个时刻之外发生的事，一律看不见。具体是三类：

| # | 盲区 | 典型现象 | 为什么快照看不见 |
|---|------|---------|-----------------|
| ① | **没装通道** | 页面闪了个错误提示条、按钮变红了又变回来 | 事件发生在两次快照之间，没有任何记录 |
| ② | **通道装错** | 点开一个下拉框，菜单明明展开了，DOM 却一点没变 | 是**纯 CSS display 展开**，根本不发 DOM 事件，`MutationObserver` 白等 |
| ③ | **只有快照没录像** | "我点了但没反应" | 只看得到点击后的结果状态，看不到点击瞬间**最上层是谁**（遮罩？伪元素？） |

这三类我在真实场景里全踩过——B 站投稿页的下拉菜单就是第②类，`MutationObserver` 挂在上面
七分钟一个事件都不报，而实际上它早就展开了。

## 解法：先装观察器，再动手，事后倒时间线

```
① 没装通道    →  MutationObserver(childList + subtree) → DomAdd / DomRemove
② 通道装错    →  页面内每 100ms 采样 computedStyle + getBoundingClientRect，
                 但**只采你指定的选择器**（外挂轮询 1.5s 会漏，页面内 100ms 抓得住）
③ 只有快照    →  上面两条天然就是持续记录 = 录像；再加一个 hitTest 看点击瞬间谁在最上层
```

关键设计：**观察器活在页面里**（`window.__EYE.events`，有上限的环形缓冲），
所以**两次工具调用之间事件不会丢**——不需要 CDP 连接一直挂着。

## 用法

> 需要 Node 18+，零依赖（只用 `node:fs` / `node:os` / `node:path`）。

```bash
# 1. 装眼睛（先想清楚哪些元素是你关心的）
node watch.mjs start --sel ".bcc-select,.bcc-select-list-wrap" --ms 100

# 2. 去做你要做的操作（点、填、提交）

# 3. 事后把这段时间线倒出来看，而不是"再拍一张"
node watch.mjs export

# 4. 想留证据就落盘
node watch.mjs export --out timeline.txt

# 只看某一类事件
node watch.mjs export --types StyleChange,DomAdd

# 点击没反应？查那个坐标点最上层是谁——专治点到遮罩/伪元素
node watch.mjs hit --x 480 --y 320

# 打一份当前样式快照，或跟上次比
node watch.mjs style --sel ".bcc-select"
node watch.mjs style --sel ".bcc-select" --diff
```

### 预设：把踩过的坑固化成选择器表

`presets/bilibili-submit.json` 是 B 站投稿页的预设，用 `--preset` 直接加载：

```bash
node watch.mjs start --preset bilibili-submit --group 创作声明
```

每条选择器都带 `why` 字段，写清"为什么是这个，上次怎么被骗的"。

## 自测：别只靠肉眼跑一遍

```bash
node selftest.mjs
```

8 条断言，三类各覆盖一次，任一失败 `exit 1`。
它会自己导航到一个内置测试页，**不碰你正在用的页面**。

## 还缺什么（诚实的边界）

- 只能看 **CDP 能看到的那个文档**：iframe / Worker / Shadow root 内部不覆盖
- **不录网络请求**：这里只有 DOM 与样式（要录网络请看别的工具）
- `--ms 100` 的采样对**一次性瞬变**（< 100ms）仍会漏；比快照强得多，但不是完美
- 依赖一个能提供 `browser.json`（含 CDP port）的本机浏览器封装；见 `cdp.mjs` 顶部注释

## License

MIT。
