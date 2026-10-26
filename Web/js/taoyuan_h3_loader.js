
/**
 * 丨桃源专用-Minimax h3素材装载 —— 前端
 *
 * 职责：
 *   1. 给三个节点挂一块真实 DOM 面板（统计 / 目标节点选择 / 屏蔽明细）
 *   2. 按「槽位号先后」把本插件 18 个固定输出自动连到官方 MiniMax H3 节点
 *
 * 自动连线的三条铁律（血泪教训，抄自 TaiYang 的实现）：
 *   · 绝不自己 splice 造 autogrow 槽 —— 前端 1.55+ 把 link↔槽 的索引搬进了
 *     slotLinks，手工 splice 只动 inputs 数组、不重建索引，重开工作流会全画错。
 *     正确做法是连到「本组最后一个槽」时，借 onConnectionsChange 的自动扩张。
 *   · 判「槽里有没有线」要遍历 graph.links，不能只看 input.link（可能有孤儿）。
 *   · 载入工作流期间绝不建链。
 */

// 注意：这里必须用绝对路径。WEB_DIRECTORY="./web" 时本文件被挂在
// /extensions/<插件目录>/js/ 下，相对的 ../../scripts/app.js 会算到
// /extensions/scripts/app.js 从而 404，整个模块不执行 —— 表现为面板空白、
// 完全不自动连线。绝对路径 /scripts/... 与挂载深度无关。
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const FRONT_VERSION = "v7";

const LOADER_TYPE = "TaoyuanMiniMaxH3Loader";
const CHECK_TYPE = "TaoyuanMiniMaxH3Check";
const TAGS_TYPE = "TaoyuanMiniMaxH3Tags";
const R2V_TYPE = "MiniMaxH3ReferenceToVideo";
const I2V_TYPE = "MiniMaxH3ImageToVideo";

const MODE_OMNI = "全模态参考";
const MODE_FL = "首尾帧";
const MODE_T2V = "文生视频";

/** 本插件输出槽 ↔ 官方节点 autogrow 组的映射（输出槽 0 基） */
const GROUPS = [
  { id: "images", inPrefix: "image_", out: 0, cap: 9, group: "ref_images", prefix: "ref_image_" },
  { id: "videos", inPrefix: "video_", out: 9, cap: 3, group: "ref_videos", prefix: "ref_video_" },
  { id: "audios", inPrefix: "audio_", out: 12, cap: 3, group: "ref_audios", prefix: "ref_audio_" },
  { id: "video_audios", inPrefix: "video_audio_", out: 15, cap: 3, group: "ref_video_audios", prefix: "ref_video_audio_" },
];

const MEDIA_OUTPUTS = 18;
const IMAGE_CAP = 9;
const VIDEO_CAP = 3;
const AUDIO_CAP = 3;
const PANEL_H = 420;
const PANEL_MIN_W = 300;

// ---------------------------------------------------------------- 小工具

function log(...args) {
  console.log("[桃源H3素材装载]", ...args);
}

function widgetOf(node, name) {
  const ws = node?.widgets || [];
  for (const w of ws) {
    if (w.name === name) return w;
  }
  return null;
}

function widgetValue(node, name, fallback) {
  const w = widgetOf(node, name);
  return w ? w.value : fallback;
}

function setWidgetValue(node, name, value) {
  const w = widgetOf(node, name);
  if (!w) return;
  w.value = value;
  try {
    w.callback?.(value);
  } catch (e) {
    /* ComfyUI 的 widget 回调偶尔会抛，忽略 */
  }
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function allLinks(graph) {
  const links = graph?.links;
  if (!links) return [];
  try {
    if (typeof links.values === "function") return Array.from(links.values());
  } catch (e) {
    /* 普通数组走下面 */
  }
  return Array.isArray(links) ? links : [];
}

/** 目标节点某个输入槽上的所有线（含孤儿），返回 link 对象数组 */
function linksIntoSlot(graph, nodeId, slotIndex) {
  const out = [];
  for (const link of allLinks(graph)) {
    if (!link) continue;
    if (link.target_id === nodeId && link.target_slot === slotIndex) out.push(link);
  }
  return out;
}

function linkExists(graph, linkId) {
  for (const link of allLinks(graph)) {
    if (link && link.id === linkId) return true;
  }
  return false;
}

function removeLinkHard(graph, link) {
  if (!link) return;
  const linkId = link.id;
  // 有些版本的 removeLink 只认对象，有些只认 id，两样都试，最后校验是否真没了
  if (linkExists(graph, linkId)) {
    try {
      graph.removeLink?.(link);
    } catch (e) {
      /* 试下一种 */
    }
  }
  if (linkExists(graph, linkId)) {
    try {
      graph.removeLink?.(linkId);
    } catch (e) {
      /* 兜底走下面的手动清理 */
    }
  }
  // 兜底：把残留引用清掉，避免留下「看不见但还在」的孤儿线
  try {
    const dst = graph.getNodeById?.(link.target_id);
    if (dst && Array.isArray(dst.inputs)) {
      const inp = dst.inputs[link.target_slot];
      if (inp && inp.link === linkId) inp.link = null;
    }
  } catch (e) {
    /* ignore */
  }
  try {
    const src = graph.getNodeById?.(link.origin_id);
    if (src && Array.isArray(src.outputs)) {
      const outp = src.outputs[link.origin_slot];
      if (outp && Array.isArray(outp.links)) {
        const at = outp.links.indexOf(linkId);
        if (at >= 0) outp.links.splice(at, 1);
      }
    }
  } catch (e) {
    /* ignore */
  }
  if (graph._version != null) graph._version++;
}

function disconnectSlot(node, slotIndex) {
  const inp = node?.inputs?.[slotIndex];
  if (!inp) return;
  try {
    node.disconnectInput?.(slotIndex, true);
  } catch (e) {
    /* ignore */
  }
  const leftovers = linksIntoSlot(node.graph || app.graph, node.id, slotIndex);
  for (const link of leftovers) removeLinkHard(node.graph || app.graph, link);
  inp.link = null;
}

/** 把 src 的第 outIndex 个输出接到 dst 的第 dstIndex 个输入（会先清掉旧线） */
function connectSlot(src, outIndex, dst, dstIndex) {
  if (!src || !dst || dstIndex < 0) return false;
  const graph = dst.graph || src.graph || app.graph;
  const existing = linksIntoSlot(graph, dst.id, dstIndex);
  for (const link of existing) {
    if (link.origin_id === src.id && link.origin_slot === outIndex) {
      // 已经是这条线了，但槽位引用可能没同步，补一下
      const inp = dst.inputs?.[dstIndex];
      if (inp && inp.link == null) inp.link = link.id;
      return true;
    }
    disconnectSlot(dst, dstIndex);
    break;
  }

  const hasLinkTo = () =>
    (dst.inputs?.[dstIndex]?.link != null) ||
    linksIntoSlot(graph, dst.id, dstIndex).length > 0;

  let ok = false;
  try {
    // LGraphNode.connect(slotIndex, targetNode, targetSlotIndex)
    if (typeof src.connect === "function") {
      const link = src.connect(outIndex, dst, dstIndex);
      ok = !!link || hasLinkTo();
    }
  } catch (e) {
    /* 下面兜底 */
  }
  if (!ok) {
    try {
      // 注意参数顺序是 (输出槽, 目标节点, 输入槽)
      const inp = dst.inputs?.[dstIndex];
      const outp = src.outputs?.[outIndex];
      if (inp && outp && typeof src.connectSlots === "function") {
        const link = src.connectSlots(outp, dst, inp);
        ok = !!link || hasLinkTo();
      }
    } catch (e) {
      /* ignore */
    }
  }
  if (!ok) {
    // LiteGraph 图对象上的老接口，最后再试一次
    try {
      graph.connect?.(src, outIndex, dst, dstIndex);
      ok = hasLinkTo();
    } catch (e) {
      /* ignore */
    }
  }
  return !!ok;
}

// ------------------------------------------------------- autogrow 槽位查找

// 槽名有两种可能：`images.image_0`（新版前端带组前缀）或 `image_0`（只有局部名）。
// 两种都认，别赌前端用哪一种。
function slotOrdinalOf(name, group, prefix) {
  if (!name || typeof name !== "string") return -1;
  const full = `${group}.${prefix}`;
  let tail = null;
  if (name.startsWith(full)) tail = name.slice(full.length);
  else if (name.startsWith(prefix)) tail = name.slice(prefix.length);
  else return -1;
  return /^\d+$/.test(tail) ? Number(tail) : -1;
}

function localSlotName(name) {
  const text = String(name ?? "");
  const dot = text.indexOf(".");
  return dot >= 0 ? text.slice(dot + 1) : text;
}

function isGroupSlot(node, group, prefix, input) {
  return slotOrdinalOf(input?.name, group, prefix) >= 0;
}

function findGroupSlot(node, group, prefix, ordinal) {
  const inputs = node?.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    if (slotOrdinalOf(inputs[i]?.name, group, prefix) === ordinal) return i;
  }
  return -1;
}

function groupSlots(node, group, prefix) {
  const result = [];
  const inputs = node?.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    const ordinal = slotOrdinalOf(inputs[i]?.name, group, prefix);
    if (ordinal >= 0) result.push({ index: i, ordinal, name: inputs[i].name });
  }
  result.sort((a, b) => a.ordinal - b.ordinal);
  return result;
}

/** 在目标节点上按槽名找输入下标，同样兼容两种命名 */
function findInputIndex(target, name) {
  const local = localSlotName(name);
  const inputs = target?.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    const candidate = inputs[i]?.name;
    if (candidate === name || candidate === local) return i;
  }
  return -1;
}

/**
 * 让目标节点把某一组 autogrow 再扩一个槽出来。
 * 做法：把「本组最后一个已连线的槽」断开再接回 —— 前端 onConnectionsChange
 * 会调用 autogrowInputConnected，自己把新槽补上。
 */
function growGroup(target, group, prefix) {
  const slots = groupSlots(target, group, prefix);
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const inp = target.inputs?.[slot.index];
    if (!inp || inp.link == null) continue;
    const graph = target.graph || app.graph;
    const link = allLinks(graph).find((l) => l && l.id === inp.link);
    if (!link) continue;
    const src = graph.getNodeById?.(link.origin_id);
    if (!src) continue;
    const outIndex = link.origin_slot;
    const before = (target.inputs || []).length;
    disconnectSlot(target, slot.index);
    let again = findGroupSlot(target, group, prefix, slot.ordinal);
    if (again < 0) {
      // 断开后该槽被前端收掉了：退回到本组最后一个还存在的槽，别把线弄丢
      const remain = groupSlots(target, group, prefix);
      if (remain.length) again = remain[remain.length - 1].index;
    }
    if (again < 0) return false;
    const ok = connectSlot(src, outIndex, target, again);
    const after = (target.inputs || []).length;
    if (after > before) return true;
    if (ok && after === before) {
      // 接回去了但没扩张：可能已经是最后一槽，交给上层重试
      continue;
    }
  }
  return false;
}

// ------------------------------------------------------------ 目标节点解析

function expectedTargetType(mode) {
  if (mode === MODE_FL) return I2V_TYPE;
  if (mode === MODE_OMNI) return R2V_TYPE;
  return null;
}

function findTargetById(nodeId) {
  if (nodeId == null || nodeId === "") return null;
  const graph = app.graph;
  return graph.getNodeById?.(nodeId) || graph.getNodeById?.(Number(nodeId)) || null;
}

function resolveTarget(node, mode) {
  const wantType = expectedTargetType(mode);
  if (!wantType) return null;

  const picked = targetChoice(node);
  if (picked != null) {
    const byId = findTargetById(picked);
    if (byId && byId.type === wantType) return byId;
  }

  const graph = app.graph;
  const nodes = graph?._nodes || [];
  const candidates = nodes.filter((n) => n && n.type === wantType);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // 多个候选时挑离插件最近的那个，省得用户还要手动选
    let best = null;
    let bestDist = Infinity;
    for (const cand of candidates) {
      const dx = (cand.pos?.[0] || 0) - (node.pos?.[0] || 0);
      const dy = (cand.pos?.[1] || 0) - (node.pos?.[1] || 0);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
    return best;
  }
  return null;
}

// -------------------------------------------------------------- 连线意图

/** 某组输入端接了几条线（每条线 = 一份素材来源） */
function groupInputCount(node, group) {
  const graph = node.graph || app.graph;
  let count = 0;
  const inputs = node.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    if (isGroupSlot(node, group.id, group.inPrefix, inputs[i])) {
      if (linksIntoSlot(graph, node.id, i).length > 0) count++;
    }
  }
  return count;
}

/** 输入端的连线指纹：任何一条线变化都会换指纹，用来判断上次报告是否过期 */
function inputSignature(node) {
  const graph = node.graph || app.graph;
  const parts = [];
  for (const group of GROUPS) {
    const ids = [];
    const inputs = node.inputs || [];
    for (let i = 0; i < inputs.length; i++) {
      if (!isGroupSlot(node, group.id, group.inPrefix, inputs[i])) continue;
      for (const link of linksIntoSlot(graph, node.id, i)) ids.push(link.id);
    }
    ids.sort((a, b) => a - b);
    parts.push(`${group.id}:${ids.join(",")}`);
  }
  return parts.join("|");
}

function reportCounts(node) {
  const report = node?.properties?.tyH3Report;
  if (!report || !report.counts) return null;
  if (node.properties.tyH3ReportSig !== inputSignature(node)) return null;
  return report.counts;
}

/**
 * 某一组该连几条。
 *   · 输入端没线 → 0
 *   · 有报告且指纹未过期 → 报告里的放行数量（被屏蔽的自然不占槽）
 *   · 指纹过期 / 从没跑过 → 铺满上限（宁可多连，也不能漏素材）
 * 有输入线时至少留 1 条，保证本节点始终在执行的链路上，报告能一直刷新。
 */
function wantedCount(node, group) {
  const inputs = groupInputCount(node, group);
  if (inputs <= 0) return 0;
  const counts = reportCounts(node);
  let count;
  if (counts && typeof counts[group.id] === "number") {
    count = Math.min(counts[group.id], group.cap);
  } else {
    count = group.cap;
  }
  return Math.max(1, count);
}

function desiredWiring(node) {
  const mode = widgetValue(node, "mode", MODE_OMNI);
  const list = [];
  if (mode === MODE_T2V) return list;

  const target = resolveTarget(node, mode);
  if (!target) return list;

  if (mode === MODE_FL) {
    const images = groupInputCount(node, GROUPS[0]);
    if (images > 0) {
      const counts = reportCounts(node);
      const available = counts ? Math.min(counts.images || 0, 2) : 2;
      const count = Math.max(1, available);
      list.push({ out: 0, targetId: target.id, name: "first_frame" });
      if (count > 1) list.push({ out: 1, targetId: target.id, name: "last_frame" });
    }
    return list;
  }

  for (const group of GROUPS) {
    const count = wantedCount(node, group);
    for (let i = 0; i < count; i++) {
      list.push({
        out: group.out + i,
        targetId: target.id,
        name: `${group.group}.${group.prefix}${i}`,
        group: group.group,
        prefix: group.prefix,
      });
    }
  }
  return list;
}

function currentWiring(node) {
  const graph = node.graph || app.graph;
  const links = allLinks(graph);
  const list = [];
  for (let out = 0; out < MEDIA_OUTPUTS; out++) {
    const outp = node.outputs?.[out];
    if (!outp) continue;
    const ids = Array.isArray(outp.links) ? outp.links.slice() : [];
    for (const id of ids) {
      const link = links.find((l) => l && l.id === id);
      if (!link) {
        list.push(`${out}->dangling:${id}`);
        continue;
      }
      const dst = graph.getNodeById?.(link.target_id);
      const name = dst?.inputs?.[link.target_slot]?.name ?? `slot${link.target_slot}`;
      list.push({ out, targetId: link.target_id, name });
    }
  }
  return list;
}

function signatureOf(list) {
  return list
    .map((item) =>
      typeof item === "string"
        ? item
        : `${item.out}->${item.targetId}:${localSlotName(item.name)}`
    )
    .sort()
    .join(";");
}

// ------------------------------------------------------------ 执行连线

// 注意执行顺序：先把想要的都接上，再摘掉多余的线。
// 原因是前端 autogrow 在槽被断开后会用 requestAnimationFrame 收掉尾部空槽，
// 若「先全清再全连」，槽位会在中途消失，后面的连接全部落空。
function linkKeyOf(graph, link) {
  const dst = graph.getNodeById?.(link.target_id);
  const name = dst?.inputs?.[link.target_slot]?.name;
  return `${link.origin_slot}->${link.target_id}:${localSlotName(name)}`;
}

function pruneExtraLinks(node, desired) {
  const graph = node.graph || app.graph;
  const keep = new Set(
    desired.map((d) => `${d.out}->${d.targetId}:${localSlotName(d.name)}`)
  );
  for (const link of allLinks(graph).slice()) {
    if (!link || link.origin_id !== node.id) continue;
    if (link.origin_slot >= MEDIA_OUTPUTS) continue;
    if (keep.has(linkKeyOf(graph, link))) continue;
    removeLinkHard(graph, link);
  }
  // 清掉输出槽上残留的悬空 link id
  for (let out = 0; out < MEDIA_OUTPUTS; out++) {
    const outp = node.outputs?.[out];
    if (!outp || !Array.isArray(outp.links) || !outp.links.length) continue;
    outp.links = outp.links.filter((id) => linkExists(graph, id));
  }
}

function wireOne(node, outIndex, target, inputName, group, prefix) {
  let idx = findInputIndex(target, inputName);
  if (idx < 0 && group && prefix) {
    // autogrow 还没扩到这一槽，借「断最后一槽再连回」唤醒它
    for (let attempt = 0; attempt < 3 && idx < 0; attempt++) {
      if (!growGroup(target, group, prefix)) break;
      idx = findInputIndex(target, inputName);
    }
  }
  if (idx < 0) {
    log("目标节点上没有这个槽", inputName);
    return false;
  }
  return connectSlot(node, outIndex, target, idx);
}

function rewire(node, { force = false } = {}) {
  if (!node || node._tyWiring) return;
  if (graphLoading()) return;
  if (widgetValue(node, "auto_wire", true) === false && !force) return;

  const desired = desiredWiring(node);
  const desiredSig = signatureOf(desired);
  const currentSig = signatureOf(currentWiring(node));
  if (!force && desiredSig === currentSig) {
    node._tyStatus = { ...(node._tyStatus || {}), at: Date.now(), ok: true };
    return;
  }

  node._tyWiring = true;
  try {
    let done = 0;
    for (const item of desired) {
      const target = findTargetById(item.targetId);
      if (!target) continue;
      if (wireOne(node, item.out, target, item.name, item.group, item.prefix)) done++;
    }
    pruneExtraLinks(node, desired);
    node._tyStatus = {
      at: Date.now(),
      ok: done === desired.length,
      targetId: desired[0]?.targetId ?? null,
      wired: done,
      total: desired.length,
    };
    if (done !== desired.length) {
      log(`接线 ${done}/${desired.length}`, node._tyStatus);
    }
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (e) {
    node._tyStatus = { at: Date.now(), ok: false, error: String(e) };
    console.error("[桃源H3素材装载] 自动连线失败", e);
  } finally {
    node._tyWiring = false;
  }
}

// -------------------------------------------------------------- 载入保护

let loadingGraph = false;
let loadingSince = 0;

function graphLoading() {
  // 兜底：万一 afterConfigureGraph 没来，也不能一直卡着不连线
  if (loadingGraph && Date.now() - loadingSince > 4000) {
    loadingGraph = false;
  }
  return loadingGraph;
}

// ComfyUI 的载入钩子是扩展服务里的 beforeConfigureGraph / afterConfigureGraph，
// 不是 app.graph 上的方法（挂到 graph 上永远不会被调用）。
function markGraphLoading() {
  loadingGraph = true;
  loadingSince = Date.now();
}

function markGraphLoaded() {
  setTimeout(() => {
    loadingGraph = false;
    for (const n of app.graph?._nodes || []) {
      if (n?.type === LOADER_TYPE) scheduleSettle(n);
    }
  }, 80);
}

const settleTimers = new WeakMap();

function scheduleSettle(node, delays = [60, 320, 1200, 3000]) {
  const old = settleTimers.get(node);
  if (old) old.forEach((t) => clearTimeout(t));
  const timers = delays.map((ms) =>
    setTimeout(() => {
      try {
        rewire(node);
        refreshPanel(node);
      } catch (e) {
        console.error("[桃源H3素材装载] 收口失败", e);
      }
    }, ms)
  );
  settleTimers.set(node, timers);
}

// --------------------------------------------------------------- 面板渲染

const STYLE_ID = "ty-h3-panel-style";
const PANEL_CSS = `
.ty-h3 { font: 12px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #d8dee9; background: #1b1f27; border: 1px solid #2f3644; border-radius: 6px;
  padding: 6px 8px; box-sizing: border-box; width: 100%; min-width: 0;
  overflow: hidden; }
.ty-h3 * { box-sizing: border-box; }
.ty-h3-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.ty-h3-title { font-weight: 600; color: #eaf0f8; letter-spacing: .3px; }
.ty-h3-mode { font-size: 11px; color: #8fd0ff; background: #22304a; border-radius: 9px; padding: 1px 8px; }
.ty-h3-row { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
.ty-h3-row label { color: #93a1b5; white-space: nowrap; }
.ty-h3 select { flex: 1; min-width: 0; background: #141821; color: #d8dee9;
  border: 1px solid #333c4d; border-radius: 4px; padding: 2px 4px; font-size: 11px; }
.ty-h3 button { background: #2a3446; color: #cfe2ff; border: 1px solid #3a4761;
  border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
.ty-h3 button:hover { background: #35425a; }
.ty-h3-sum { color: #9fb3c8; font-size: 11px; margin: 2px 0 4px; }
.ty-h3-sum b { color: #eaf0f8; font-weight: 600; }
.ty-h3-item { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0;
  border-bottom: 1px dashed #262d3a; }
.ty-h3-item span:last-child { color: #7f8fa6; white-space: nowrap; }
.ty-h3-ok { color: #7bd88f; }
.ty-h3-bad { color: #ff6b6b; }
.ty-h3-warn { color: #e8c46a; }
.ty-h3-empty { color: #7f8fa6; font-style: italic; }
.ty-h3-sec { margin-top: 6px; border-top: 1px solid #262d3a; padding-top: 4px; }
.ty-h3-sec-hd { display: flex; justify-content: space-between; align-items: baseline;
  color: #93a1b5; font-size: 11px; margin-bottom: 3px; }
.ty-h3-sec-hd b { color: #cfe2ff; font-weight: 600; letter-spacing: .3px; }
.ty-h3-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.ty-h3-cell { position: relative; aspect-ratio: 1 / 1; background: #12161d;
  border: 1px dashed #333c4d; border-radius: 4px; overflow: hidden;
  display: flex; align-items: center; justify-content: center; }
.ty-h3-cell.filled { border-style: solid; border-color: #3a5a7a; cursor: zoom-in; }
.ty-h3-cell.filled:hover { border-color: #6fa8dc; }
.ty-h3-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ty-h3-cell .num { position: absolute; left: 2px; top: 1px; font-size: 10px;
  color: #cfe2ff; background: rgba(10, 14, 20, .72); border-radius: 3px; padding: 0 3px; }
.ty-h3-cell .ph { color: #5b6879; font-size: 10px; }
.ty-h3-vcell { border: 1px solid #333c4d; border-radius: 4px; overflow: hidden;
  background: #12161d; }
.ty-h3-vcell.filled { border-color: #3a5a7a; cursor: zoom-in; }
.ty-h3-vcell.filled:hover { border-color: #6fa8dc; }
.ty-h3-vcell img { width: 100%; height: 42px; object-fit: cover; display: block; }
.ty-h3-vcell .cap { font-size: 10px; color: #9fb3c8; padding: 1px 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ty-h3-aitem { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.ty-h3-aitem .nm { color: #cfe2ff; width: 62px; flex: none; font-size: 11px; }
.ty-h3-bars { display: flex; align-items: flex-end; gap: 1px; height: 16px;
  flex: 1; min-width: 0; }
.ty-h3-bars i { flex: 1; background: #4a7fb5; border-radius: 1px; min-height: 1px; }
.ty-h3-aitem .tm { color: #7f8fa6; width: 52px; text-align: right; flex: none; font-size: 11px; }
.ty-h3-aitem.playable { cursor: pointer; border-radius: 4px; }
.ty-h3-aitem.playable:hover { background: #232b39; }
.ty-h3-aitem.playable .nm { color: #8fd0ff; }
.ty-h3-fl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.ty-h3-flbox { position: relative; background: #12161d; border: 1px dashed #333c4d;
  border-radius: 4px; overflow: hidden; aspect-ratio: 3 / 4; display: flex;
  align-items: center; justify-content: center; }
.ty-h3-flbox.filled { border-style: solid; border-color: #3a5a7a; cursor: zoom-in; }
.ty-h3-flbox img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ty-h3-flbox .cap { position: absolute; left: 0; right: 0; bottom: 0; font-size: 10px;
  color: #cfe2ff; background: rgba(10, 14, 20, .72); padding: 1px 4px; }
.ty-h3-flbox .ph { color: #5b6879; font-size: 10px; }
.ty-h3-note { color: #7f8fa6; font-size: 11px; padding: 6px 0; text-align: center; }
.ty-h3-ov { position: fixed; inset: 0; z-index: 99999; background: rgba(8, 10, 14, .88);
  display: flex; align-items: center; justify-content: center; font: 12px/1.45 sans-serif; }
.ty-h3-ov-box { position: relative; max-width: 92vw; max-height: 92vh; display: flex;
  flex-direction: column; gap: 6px; align-items: center; }
.ty-h3-ov-box img { max-width: 92vw; max-height: 84vh; object-fit: contain;
  border-radius: 6px; background: #000; }
.ty-h3-ov-box video { max-width: 92vw; max-height: 84vh; border-radius: 6px; background: #000; }
.ty-h3-ov-box audio { width: min(560px, 82vw); }
.ty-h3-ov-cap { color: #cfe2ff; font-size: 12px; }
.ty-h3-ov-tip { color: #e8c46a; font-size: 13px; padding: 18px 24px; }
.ty-h3-ov-x { position: absolute; right: -10px; top: -12px; width: 24px; height: 24px;
  background: #2a3446; color: #cfe2ff; border: 1px solid #3a4761; border-radius: 50%;
  cursor: pointer; line-height: 1; }
.ty-h3-ov-x:hover { background: #35425a; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

function reportOf(node) {
  return node?.properties?.tyH3Report || null;
}

function targetChoice(node) {
  const raw = String(node?.properties?.tyH3Target || "");
  const m = raw.match(/#?(\d+)/);
  return m ? Number(m[1]) : null;
}

function targetOptionsHtml(node) {
  const nodes = app.graph?._nodes || [];
  const wantType = expectedTargetType(widgetValue(node, "mode", MODE_OMNI));
  const picked = targetChoice(node);
  const out = [`<option value="">自动（就近）</option>`];
  if (!wantType) return out.join("");
  for (const cand of nodes) {
    if (!cand || cand.id === node.id || cand.type !== wantType) continue;
    const label = `#${cand.id} ${cand.title ? String(cand.title) : ""}`.trim();
    const sel = cand.id === picked ? " selected" : "";
    out.push(`<option value="${cand.id}"${sel}>${escapeHtml(label)}</option>`);
  }
  return out.join("");
}

function wiringStatusHtml(node) {
  const mode = widgetValue(node, "mode", MODE_OMNI);
  if (node.type === LOADER_TYPE && mode === MODE_T2V) {
    return `<div class="ty-h3-sum">文生视频模式：不连任何素材</div>`;
  }
  const target = resolveTarget(node, mode);
  if (!target) {
    return `<div class="ty-h3-item ty-h3-bad"><span>没有找到官方 H3 节点</span>` +
      `<span>先在画布上放一个</span></div>`;
  }
  const st = node._tyStatus || {};
  const lines = GROUPS.reduce((a, g) => a + groupInputCount(node, g), 0);
  const wired = st.wired ?? "-";
  const total = st.total ?? "-";
  const cls = st.ok === false ? "ty-h3-warn" : "ty-h3-sum";
  return `<div class="${cls}">目标 #${target.id} · 已连线 ${wired}/${total}` +
    ` · 上游 ${lines} 条线 · ${FRONT_VERSION}</div>`;
}

function sectionHtml(title, body) {
  return `<div class="ty-h3-sec"><div class="ty-h3-sec-hd"><span>${title}</span></div>` +
    `${body}</div>`;
}

function imageCellHtml(item, index, hasReport) {
  if (item) {
    const inner = item.thumb
      ? `<img src="${item.thumb}" alt="">`
      : `<span class="ph">已放行</span>`;
    return `<div class="ty-h3-cell filled" data-ty-media="image" data-ty-idx="${index}"` +
      ` title="点击放大"><span class="num">${index + 1}</span>${inner}</div>`;
  }
  return `<div class="ty-h3-cell"><span class="num">${index + 1}</span>` +
    `<span class="ph">${hasReport ? "空" : "待运行"}</span></div>`;
}

function flBoxHtml(item, index, label) {
  const inner = item?.thumb ? `<img src="${item.thumb}" alt="">` : `<span class="ph">待运行</span>`;
  const attrs = item
    ? ` data-ty-media="image" data-ty-idx="${index}" title="点击放大"`
    : "";
  return `<div class="ty-h3-flbox${item ? " filled" : ""}"${attrs}>` +
    `${inner}<div class="cap">${label}</div></div>`;
}

function flSectionHtml(report) {
  const items = report?.items?.images || [];
  const body = `<div class="ty-h3-fl">${flBoxHtml(items[0], 0, "首帧")}` +
    `${flBoxHtml(items[1], 1, "尾帧")}</div>`;
  return sectionHtml(`首尾帧 <b>${items.length}/2</b>`, body);
}

function imagesSectionHtml(report) {
  const items = report?.items?.images || [];
  const cells = [];
  for (let i = 0; i < IMAGE_CAP; i++) cells.push(imageCellHtml(items[i], i, !!report));
  const head = `参考图 <b>${items.length}/${IMAGE_CAP}</b>`;
  return sectionHtml(head, `<div class="ty-h3-grid">${cells.join("")}</div>`);
}

function videosSectionHtml(report) {
  const items = report?.items?.videos || [];
  const cells = [];
  for (let i = 0; i < VIDEO_CAP; i++) {
    const it = items[i];
    if (it) {
      const img = it.thumb ? `<img src="${it.thumb}" alt="">` : "";
      const cap = `视频${i + 1} · ${Number(it.duration).toFixed(2)}s · ${it.frames}帧`
        + (it.paired_audio ? " · +音轨" : "");
      cells.push(`<div class="ty-h3-vcell filled" data-ty-media="video" data-ty-idx="${i}"` +
        ` title="点击播放">${img}` +
        `<div class="cap">${escapeHtml(cap)}</div></div>`);
    } else {
      cells.push(`<div class="ty-h3-vcell"><div class="cap">视频${i + 1} · ` +
        `${report ? "空" : "待运行"}</div></div>`);
    }
  }
  const head = `参考视频 <b>${items.length}/${VIDEO_CAP}</b>`;
  return sectionHtml(head, `<div class="ty-h3-grid">${cells.join("")}</div>`);
}

function audioRowsHtml(items, hasReport, key) {
  const rows = [];
  for (let i = 0; i < AUDIO_CAP; i++) {
    const it = items[i];
    if (it) {
      const peaks = Array.isArray(it.peaks) ? it.peaks : [];
      const bars = peaks.length
        ? peaks.map((p) => `<i style="height:${Math.max(8, Math.round(p * 100))}%"></i>`).join("")
        : `<i style="height:30%"></i>`;
      rows.push(`<div class="ty-h3-aitem playable" data-ty-media="${key}" data-ty-idx="${i}"` +
        ` title="点击播放"><span class="nm">音频${i + 1}</span>` +
        `<span class="ty-h3-bars">${bars}</span>` +
        `<span class="tm">${Number(it.duration).toFixed(2)}s</span></div>`);
    } else {
      rows.push(`<div class="ty-h3-aitem ty-h3-empty"><span class="nm">音频${i + 1}</span>` +
        `<span class="ty-h3-bars"><i style="height:20%"></i></span>` +
        `<span class="tm">${hasReport ? "空" : "待运行"}</span></div>`);
    }
  }
  return rows.join("");
}

function audiosSectionHtml(report, key, label) {
  const items = report?.items?.[key] || [];
  const head = `${label} <b>${items.length}/${AUDIO_CAP}</b>`;
  return sectionHtml(head, audioRowsHtml(items, !!report, key));
}

// ------------------------------------------------------------- 素材预览浮层

let mediaOverlay = null;

function overlayEl() {
  if (mediaOverlay && mediaOverlay.isConnected) return mediaOverlay;
  const el = document.createElement("div");
  el.className = "ty-h3-ov";
  el.style.display = "none";
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.target === el) closeMediaOverlay();
  });
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  document.body.appendChild(el);
  mediaOverlay = el;
  if (!window.__tyH3OvKey) {
    window.__tyH3OvKey = true;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMediaOverlay();
    });
  }
  return el;
}

function closeMediaOverlay() {
  if (!mediaOverlay) return;
  mediaOverlay.style.display = "none";
  mediaOverlay.innerHTML = "";
}

function previewUrl(node, kind, index) {
  const token = reportOf(node)?.preview?.token;
  if (!token) return null;
  const base = kind === "audios" || kind === "video_audios" ? "audio" : kind;
  let path = `/ty_h3/${base}?t=${encodeURIComponent(token)}&i=${index}`;
  if (base === "audio") path += `&k=${kind}`;
  return typeof api?.apiURL === "function" ? api.apiURL(path) : path;
}

function openMediaOverlay(node, kind, index) {
  const root = overlayEl();
  const url = previewUrl(node, kind, index);
  if (!url) {
    root.style.display = "flex";
    root.innerHTML = `<div class="ty-h3-ov-box">` +
      `<div class="ty-h3-ov-tip">还没有预览数据 —— 先运行一次本节点</div></div>`;
    setTimeout(closeMediaOverlay, 1600);
    return;
  }
  const report = reportOf(node);
  let body = "";
  let cap = "";
  if (kind === "image") {
    cap = `参考图 ${index + 1}`;
    body = `<img src="${url}" alt="">`;
  } else if (kind === "video") {
    const it = report?.items?.videos?.[index];
    cap = `参考视频 ${index + 1}` +
      (it ? ` · ${Number(it.duration).toFixed(2)}s · ${it.frames} 帧` : "");
    body = `<video src="${url}" controls autoplay playsinline></video>`;
  } else {
    const it = report?.items?.[kind]?.[index];
    cap = `${kind === "video_audios" ? "配套音频" : "独立音频"} ${index + 1}` +
      (it ? ` · ${Number(it.duration).toFixed(2)}s` : "");
    body = `<audio src="${url}" controls autoplay></audio>`;
  }
  root.style.display = "flex";
  root.innerHTML = `<div class="ty-h3-ov-box">${body}` +
    `<div class="ty-h3-ov-cap">${escapeHtml(cap)}</div>` +
    `<button class="ty-h3-ov-x" title="关闭">✕</button></div>`;
  root.querySelector(".ty-h3-ov-x")?.addEventListener("click", closeMediaOverlay);
}

function issuesHtml(report) {
  if (!report) return "";
  const rows = [];
  for (const b of report.blocked || []) {
    rows.push(`<div class="ty-h3-item ty-h3-bad"><span>⛔ ${escapeHtml(b.source)}</span>` +
      `<span>${escapeHtml(b.reason)}</span></div>`);
  }
  for (const w of report.warnings || []) {
    rows.push(`<div class="ty-h3-item ty-h3-warn"><span>⚠ ${escapeHtml(w)}</span>` +
      `<span></span></div>`);
  }
  if (!rows.length) return "";
  return sectionHtml("拦截与告警", rows.join(""));
}

function renderPanel(node) {
  const root = node?._tyPanelEl;
  if (!root) return;
  const isLoader = node.type === LOADER_TYPE;
  const report = reportOf(node);
  const mode = widgetValue(node, "mode", MODE_OMNI);
  const lines = GROUPS.reduce((a, g) => a + groupInputCount(node, g), 0);

  let html = `<div class="ty-h3-head"><span class="ty-h3-title">桃源 H3 素材装载</span>`;
  html += `<span class="ty-h3-mode">${escapeHtml(isLoader ? mode : "校验器")}</span></div>`;

  if (isLoader) {
    html += `<div class="ty-h3-row"><label>目标H3</label>`;
    html += `<select class="ty-h3-target">${targetOptionsHtml(node)}</select>`;
    html += `<button class="ty-h3-rewire">重连</button></div>`;
    html += wiringStatusHtml(node);
  }

  if (!report) {
    html += `<div class="ty-h3-sum ty-h3-empty">还没有素材数据（上游 ${lines} 条线）`
      + ` —— 跑一次就显示缩略图与时长</div>`;
  }

  if (isLoader && mode === MODE_T2V) {
    html += sectionHtml("文生视频", `<div class="ty-h3-empty">本模式不使用任何素材</div>`);
  } else if (isLoader && mode === MODE_FL) {
    html += flSectionHtml(report);
    html += audiosSectionHtml(report, "audios", "独立音频");
  } else {
    html += imagesSectionHtml(report);
    html += videosSectionHtml(report);
    html += audiosSectionHtml(report, "video_audios", "配套音频");
    html += audiosSectionHtml(report, "audios", "独立音频");
  }
  html += issuesHtml(report);
  root.innerHTML = html;

  const select = root.querySelector(".ty-h3-target");
  if (select) {
    select.addEventListener("change", () => {
      const value = select.value ? `#${select.value}` : "";
      node.properties = node.properties || {};
      node.properties.tyH3Target = value;
      rewire(node, { force: true });
      refreshPanel(node);
    });
  }
  const button = root.querySelector(".ty-h3-rewire");
  if (button) {
    button.addEventListener("click", () => {
      rewire(node, { force: true });
      refreshPanel(node);
    });
  }
  fitPanel(node);
}

/** 面板内容真实高度（跟鱼酥一样：量 scrollHeight，不量被节点拉出来的高度） */
function panelHeight(node) {
  const el = node?._tyPanelEl;
  if (!el) return PANEL_H;
  const h = el.scrollHeight || el.getBoundingClientRect().height || 0;
  return Math.max(60, Math.ceil(h) + 12);
}

/** 面板宽度跟着节点宽度走 */
function syncPanelWidth(node) {
  const el = node?._tyPanelEl;
  if (!el) return;
  const w = Math.max(Number(node.size?.[0]) || 0, PANEL_MIN_W);
  el.style.width = `${Math.max(0, w - 20)}px`;
}

/** 把节点高度钉回内容高度：用户往下拉也会被弹回去 */
function fitPanel(node) {
  if (!node?._tyPanelEl || node._tyFitting) return;
  if (!node._tyPanelEl.isConnected) {
    // 刚建好的面板还没挂进画布，量不到高度；隔一会儿再试，最多 8 次
    node._tyFitRetry = (node._tyFitRetry || 0) + 1;
    if (node._tyFitRetry < 8) setTimeout(() => fitPanel(node), 80);
    return;
  }
  node._tyFitRetry = 0;
  cancelAnimationFrame(node._tyFitRaf);
  node._tyFitRaf = requestAnimationFrame(() => {
    const el = node._tyPanelEl;
    if (!el || !el.isConnected) return;
    node._tyFitting = true;
    try {
      syncPanelWidth(node);
      const width = Math.max(Number(node.size?.[0]) || 0, PANEL_MIN_W);
      // 先把高度塌到 1，避免把工作流里存的旧高度喂回布局（鱼酥的写法）
      if (node.size) node.size[1] = 1;
      const natural = node.computeSize([width, 1]);
      const height = Math.ceil(natural[1]) || PANEL_H;
      node.setSize([width, height]);
      node.graph?.setDirtyCanvas(true, true);
    } catch (e) {
      if (node.size && node.size[1] < 20) node.size[1] = PANEL_H;
    } finally {
      node._tyFitting = false;
    }
  });
}

function refreshPanel(node) {
  try {
    renderPanel(node);
  } catch (e) {
    console.error("[桃源H3素材装载] 面板渲染失败", e);
  }
}

/** 摘掉旧面板，保证一个节点永远只挂一块 */
function dropPanel(node) {
  if (!node) return;
  try {
    if (Array.isArray(node.widgets)) {
      node.widgets = node.widgets.filter((w) => !(w && w._tyPanel));
    }
    if (Array.isArray(node.domWidgets)) {
      node.domWidgets = node.domWidgets.filter((w) => !(w && w._tyPanel));
    }
    node._tyPanelEl?.remove();
  } catch (e) {
    /* ignore */
  }
  node._tyPanelEl = null;
}

function setupPanel(node) {
  ensureStyle();
  dropPanel(node);
  const el = document.createElement("div");
  el.className = "ty-h3";
  node._tyPanelEl = el;

  // 面板内部不触发画布拖拽/缩放，只挂一次，别在 render 里重复挂
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  el.addEventListener("click", (e) => {
    const hit = e.target?.closest?.("[data-ty-media]");
    if (!hit || !el.contains(hit)) return;
    e.preventDefault();
    e.stopPropagation();
    openMediaOverlay(
      node,
      hit.getAttribute("data-ty-media"),
      Number(hit.getAttribute("data-ty-idx") || 0),
    );
  });

  if (typeof node.addDOMWidget === "function") {
    const widget = node.addDOMWidget("桃源面板", "taoyuan_h3_panel", el, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: () => {},
      getMinHeight: () => panelHeight(node),
      getMaxHeight: () => panelHeight(node),
      getHeight: () => panelHeight(node),
      afterResize: () => syncPanelWidth(node),
    });
    widget._tyPanel = true;
    widget.computeSize = (width) => [Math.max(width || 0, PANEL_MIN_W), panelHeight(node)];
    widget.serialize = false;
  } else {
    // 老前端没有 DOM widget，退化成一行文本
    node.addWidget?.("text", "桃源面板", "面板需要较新版本的 ComfyUI 前端", () => {});
  }

  syncPanelWidth(node);
  refreshPanel(node);
  fitPanel(node);
}

// ------------------------------------------------------------- 节点装配

function setupNode(node, type) {
  node._tyType = type;

  const onConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = onConnectionsChange?.apply(this, args);
    try {
      if (!this._tyWiring) {
        const self = this;
        clearTimeout(self._tyRewireTimer);
        self._tyRewireTimer = setTimeout(() => {
          try {
            rewire(self);
            refreshPanel(self);
          } catch (e) {
            console.error("[桃源H3素材装载] 连线后重排失败", e);
          }
        }, 120);
      }
    } catch (e) {
      /* ignore */
    }
    return result;
  };

  const onWidgetChanged = node.onWidgetChanged;
  node.onWidgetChanged = function (name, value, oldValue, widget) {
    const result = onWidgetChanged?.apply(this, arguments);
    try {
      if (name === "mode" || name === "auto_wire") {
        const self = this;
        clearTimeout(self._tyRewireTimer);
        self._tyRewireTimer = setTimeout(() => {
          try {
            rewire(self, { force: name === "mode" });
            refreshPanel(self);
          } catch (e) {
            console.error("[桃源H3素材装载] 切换参数后重排失败", e);
          }
        }, 60);
      }
    } catch (e) {
      /* ignore */
    }
    return result;
  };

  const onConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    try {
      setupPanel(this);
      scheduleSettle(this);
    } catch (e) {
      console.error("[桃源H3素材装载] onConfigure 失败", e);
    }
    return result;
  };

  const onRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    const timers = settleTimers.get(this);
    if (timers) timers.forEach((t) => clearTimeout(t));
    return onRemoved?.apply(this, args);
  };

  const onResize = node.onResize;
  node.onResize = function (...args) {
    const result = onResize?.apply(this, args);
    try {
      if (!this._tyFitting) fitPanel(this);
    } catch (e) {
      /* ignore */
    }
    return result;
  };

  setupPanel(node);
  setTimeout(() => {
    try {
      const count = (node.widgets || []).filter((w) => w && w._tyPanel).length;
      if (count !== 1) setupPanel(node);
    } catch (e) {
      /* ignore */
    }
  }, 1500);
  if (type === LOADER_TYPE) scheduleSettle(node);
}

// --------------------------------------------------------------- 扩展注册

app.registerExtension({
  name: "桃源.H3素材装载",

  beforeConfigureGraph() {
    markGraphLoading();
  },

  afterConfigureGraph() {
    markGraphLoaded();
  },

  loadedGraphNode(node) {
    if (node?.type === LOADER_TYPE) scheduleSettle(node);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const type = nodeData?.name;
    if (![LOADER_TYPE, CHECK_TYPE, TAGS_TYPE].includes(type)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      try {
        setupNode(this, type);
      } catch (e) {
        console.error("[桃源H3素材装载] 初始化失败", e);
      }
      return result;
    };
  },

  async setup() {
    // 后端执行完把报告推过来
    api.addEventListener("executed", (event) => {
      try {
        const detail = event?.detail || {};
        const nodeId = detail.node ?? detail.display_node;
        const node = findTargetById(nodeId);
        if (!node || !node._tyPanelEl) return;
        const payload = detail.output?.report;
        if (!payload) return;
        const raw = Array.isArray(payload) ? payload[0] : payload;
        if (!raw) return;
        const report = typeof raw === "string" ? JSON.parse(raw) : raw;
        node.properties = node.properties || {};
        node.properties.tyH3Report = report;
        node.properties.tyH3ReportSig = inputSignature(node);
        refreshPanel(node);
        if (node.type === LOADER_TYPE) {
          // 报告出来了，按真实放行数量把多余的线收掉
          setTimeout(() => {
            try {
              rewire(node);
              refreshPanel(node);
            } catch (e) {
              console.error("[桃源H3素材装载] 按报告收线失败", e);
            }
          }, 30);
        }
      } catch (e) {
        console.error("[桃源H3素材装载] 处理报告失败", e);
      }
    });

    // 兜底轮询：图形变化 → 重排（不依赖前端事件差异）
    setInterval(() => {
      try {
        if (graphLoading()) return;
        for (const node of app.graph?._nodes || []) {
          if (!node || node.type !== LOADER_TYPE) continue;
          if (node._tyWiring) continue;
          const desiredSig = signatureOf(desiredWiring(node));
          const currentSig = signatureOf(currentWiring(node));
          if (desiredSig !== currentSig) {
            rewire(node);
            refreshPanel(node);
          }
        }
      } catch (e) {
        /* 轮询失败不打断人 */
      }
    }, 900);

    log("已加载");
  },
});

/** 排查入口：控制台执行 __tyH3Audit() */
globalThis.__tyH3Audit = function () {
  const rows = [];
  for (const node of app.graph?._nodes || []) {
    if (node?.type !== LOADER_TYPE) continue;
    rows.push({
      node: node.id,
      mode: widgetValue(node, "mode", MODE_OMNI),
      desired: currentWiring(node),
      wanted: desiredWiring(node),
      report: node.properties?.tyH3Report?.counts || null,
    });
  }
  console.table(rows);
  return rows;
};

