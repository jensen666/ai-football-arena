import { ACTION_EFFECT_MS, GOAL_EFFECT_MS, createPoseTracker, estimateEffectDurationMs } from "./playerPose.js";

/** 设计基准画布宽度：所有固定像素尺寸都以此为基准换算，保证任意 CSS 尺寸下画面比例一致。 */
const BASE_VIEW_WIDTH = 1100;
/** 画布从未测量过时的回退高度（与 index.html 的初始 canvas 尺寸一致）。 */
const BASE_VIEW_HEIGHT = 696;
/** 静态场地离屏缓存最多保留的份数（主画布 + 回放画布，按尺寸/DPR 区分）。 */
const STATIC_FIELD_CACHE_LIMIT = 2;
/** 离屏缓存的最大渲染倍率：4K/高倍屏上限制显存占用，画质差异肉眼不可见。 */
const STATIC_FIELD_MAX_DPR = 2;
/** 点球点半径与透明度：比原来更小更淡，避免远看像场上有第三颗球。 */
const PENALTY_SPOT_RADIUS = 1.8;
const PENALTY_SPOT_ALPHA = 0.35;
/** 重开球白色遮罩的时长与初始透明度。 */
const KICKOFF_FLASH_MS = 200;
const KICKOFF_FLASH_ALPHA = 0.28;
/** 触发重开球过渡的上一帧比赛状态。 */
const KICKOFF_FLASH_FROM_STATES = ["goal_scored", "var_check"];
/** 预渲染阴影贴图分辨率（绘制时按球员尺寸缩放）。 */
const SHADOW_SPRITE_WIDTH = 128;
const SHADOW_SPRITE_HEIGHT = 48;
/** 回放时间轴断档超过该值视为新一次回放，重置回放姿态追踪器。 */
const REPLAY_RESET_GAP_MS = 500;
/** 动作事件为空时复用的只读数组：回放路径完全不接触实时特效列表。 */
const EMPTY_EFFECTS = Object.freeze([]);

let canvas = null;
let ctx = null;
/** 当前绘制视图：width/height 为 CSS 像素，scale 为相对设计基准的缩放比例。 */
let view = { width: BASE_VIEW_WIDTH, height: BASE_VIEW_HEIGHT, scale: 1, dpr: 1, bufferWidth: BASE_VIEW_WIDTH, bufferHeight: BASE_VIEW_HEIGHT };
let debugTarget = {};
let visualEffects = [];
const seenVisualEffectIds = new Set();
/** 实时画面与回放画面各一个姿态追踪器，天然隔离步频/朝向/入网计时。 */
const livePoseTracker = createPoseTracker();
const replayPoseTracker = createPoseTracker();
/** 每块画布上一次有效的 CSS 视图（画布隐藏导致 clientWidth=0 时回退使用）。 */
const canvasViews = new WeakMap();
/** 静态场地离屏缓存：key = `${cssW}x${cssH}@${cacheDpr}`。 */
const staticFieldCaches = new Map();
/** 预渲染的球员阴影贴图（径向渐变），替代每个球员的 ctx.shadowBlur。 */
let shadowSprite = null;
/** 号码字体字符串缓存：字号量化后复用，避免每帧拼接字符串。 */
const fontCache = new Map();
/** 重开球过渡遮罩状态 { startedAt }。 */
let kickoffFlash = null;
/** 实时画面上一帧的比赛状态名，用于识别“进球/VAR → kickoff”的切换。 */
let lastLiveMatchState = null;
/** 回放上一帧时间戳，用于识别一次新的回放播放。 */
let lastReplayTime = 0;

/** 初始化渲染器：记录主画布、2D 上下文与调试对象。 */
export function initPitchRenderer(targetCanvas, debug = {}) {
  canvas = targetCanvas;
  ctx = canvas.getContext("2d");
  debugTarget = debug || {};
}

/** 清空全部视觉特效与实时姿态状态（重开/切换比赛时调用）。 */
export function clearVisualEffects() {
  visualEffects = [];
  seenVisualEffectIds.clear();
  livePoseTracker.reset();
  kickoffFlash = null;
  lastLiveMatchState = null;
  debugTarget.visualEffectCount = 0;
}

/** 入队一条动作事件特效：时长由轨迹距离与引擎飞行速度推算，不再写死 1600/900ms。 */
export function queueVisualEffect(event, recentEvents = []) {
  if (!event?.action_event_id || seenVisualEffectIds.has(event.action_event_id)) return;
  if (!event.trajectory && !event.actor && !event.target) return;
  seenVisualEffectIds.add(event.action_event_id);
  visualEffects.push({ id: event.action_event_id, type: event.action_type, actor: event.actor, target: event.target, trajectory: event.trajectory, durationMs: estimateEffectDurationMs(event), startedAt: performance.now() });
  if (seenVisualEffectIds.size > 80) {
    const keep = new Set(recentEvents.map((item) => item.action_event_id).filter(Boolean));
    for (const id of seenVisualEffectIds) if (!keep.has(id)) seenVisualEffectIds.delete(id);
  }
}

/** 绘制实时比赛画面。 */
export function drawPitch(state, time = performance.now()) {
  drawPitchTo(canvas, ctx, state, time, { skipEffects: false, tracker: livePoseTracker });
}

/** 绘制回放画面：不读取实时特效，姿态使用独立的回放追踪器。 */
export function drawReplayFrame(targetCanvas, state, time = performance.now()) {
  const targetCtx = targetCanvas.getContext("2d");
  if (lastReplayTime && (time < lastReplayTime || time - lastReplayTime > REPLAY_RESET_GAP_MS)) replayPoseTracker.reset();
  lastReplayTime = time;
  drawPitchTo(targetCanvas, targetCtx, state, time, { skipEffects: true, tracker: replayPoseTracker });
}

/** 在指定画布上完成一帧绘制（实时与回放共用同一条绘制流水线）。 */
function drawPitchTo(targetCanvas, targetCtx, state, time, options = {}) {
  const savedCanvas = canvas;
  const savedCtx = ctx;
  const savedView = view;
  canvas = targetCanvas;
  ctx = targetCtx;
  try {
    const drawState = state || mockState();
    view = syncCanvasView(targetCanvas, targetCtx);
    ctx.clearRect(0, 0, view.width, view.height);
    drawField(view, drawState, time, options.skipEffects);
    if (!options.skipEffects) {
      updateKickoffFlash(drawState, time);
      drawVisualEffects(view, time);
      drawKickoffFlash(view, time);
    }
    drawReceptionTarget(drawState.ball, view, time);
    const tracker = options.tracker || livePoseTracker;
    const players = ["home", "away"]
      .flatMap((side) => drawState.teams[side].players.map((player) => ({ player, side })))
      .sort((left, right) => left.player.y - right.player.y);
    for (const { player, side } of players) {
      const isPassReceiver = drawState.ball?.pendingHolderTeam === side && drawState.ball?.pendingHolderId === player.id;
      const isHolder = !drawState.ball?.inFlight && drawState.ball?.holderTeam === side && drawState.ball?.holderId === player.id;
      drawPlayer(player, side, view, drawState, isHolder, time, isPassReceiver, tracker, options.skipEffects);
    }
    drawBall(drawState.ball, view, time, options.skipEffects);
  } finally {
    canvas = savedCanvas;
    ctx = savedCtx;
    view = savedView;
  }
}

/** 按 CSS 像素尺寸与 devicePixelRatio 同步画布缓冲区，返回当前绘制视图。
 * 隐藏画布（clientWidth=0）时回退到上一次有效尺寸，避免把缓冲区清成空白。
 */
function syncCanvasView(targetCanvas, targetCtx) {
  const lastView = canvasViews.get(targetCanvas);
  const dpr = Math.max(1, Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1));
  let cssWidth = Math.round(targetCanvas.clientWidth || 0);
  let cssHeight = Math.round(targetCanvas.clientHeight || 0);
  if (!cssWidth || !cssHeight) {
    cssWidth = lastView?.width || BASE_VIEW_WIDTH;
    cssHeight = lastView?.height || BASE_VIEW_HEIGHT;
  } else if (lastView && Math.abs(lastView.dpr - dpr) < 0.001 && Math.abs(lastView.width - cssWidth) < 0.5 && Math.abs(lastView.height - cssHeight) < 0.5) {
    // 尺寸与 DPR 未变化：复用上次视图，仅重置变换矩阵（画布缩放后状态会丢失）
    targetCtx.setTransform(lastView.bufferWidth / lastView.width, 0, 0, lastView.bufferHeight / lastView.height, 0, 0);
    return lastView;
  }
  const bufferWidth = Math.max(1, Math.round(cssWidth * dpr));
  const bufferHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (targetCanvas.width !== bufferWidth || targetCanvas.height !== bufferHeight) {
    targetCanvas.width = bufferWidth;
    targetCanvas.height = bufferHeight;
  }
  // 用缓冲区/CSS 尺寸做变换，绘制坐标全部是 CSS 像素，同时精确铺满物理像素
  targetCtx.setTransform(bufferWidth / cssWidth, 0, 0, bufferHeight / cssHeight, 0, 0);
  const nextView = { width: cssWidth, height: cssHeight, dpr, scale: cssWidth / BASE_VIEW_WIDTH, bufferWidth, bufferHeight };
  canvasViews.set(targetCanvas, nextView);
  return nextView;
}

/** 把设计基准像素尺寸换算成当前视图的 CSS 像素。 */
function scalePx(value) {
  return value * (view.scale || 1);
}

/** 绘制球场：静态部分取自离屏缓存，球门网每帧动态绘制。 */
function drawField(viewObject, state = null, time = performance.now(), skipEffects = false) {
  const cached = staticFieldCache(viewObject);
  if (cached) ctx.drawImage(cached, 0, 0, viewObject.width, viewObject.height);
  const effects = skipEffects ? EMPTY_EFFECTS : visualEffects;
  drawGoal(0, 50, -1, viewObject, state, time, effects);
  drawGoal(100, 50, 1, viewObject, state, time, effects);
}

/** 取静态场地离屏缓存；未命中时按当前尺寸/DPR 渲染一份并缓存。 */
function staticFieldCache(viewObject) {
  const cacheDpr = Math.min(STATIC_FIELD_MAX_DPR, Math.max(1, viewObject.dpr || 1));
  const key = `${Math.round(viewObject.width)}x${Math.round(viewObject.height)}@${cacheDpr}`;
  const cached = staticFieldCaches.get(key);
  if (cached) return cached;
  const surface = createSurface(Math.round(viewObject.width * cacheDpr), Math.round(viewObject.height * cacheDpr));
  if (!surface) return null;
  const surfaceCtx = surface.getContext("2d");
  if (!surfaceCtx) return null;
  surfaceCtx.setTransform(cacheDpr, 0, 0, cacheDpr, 0, 0);
  const savedCtx = ctx;
  const savedView = view;
  const cacheView = { ...viewObject, dpr: cacheDpr };
  ctx = surfaceCtx;
  view = cacheView;
  try {
    drawStaticField(cacheView);
  } finally {
    ctx = savedCtx;
    view = savedView;
  }
  staticFieldCaches.set(key, surface);
  if (staticFieldCaches.size > STATIC_FIELD_CACHE_LIMIT) {
    const oldestKey = staticFieldCaches.keys().next().value;
    staticFieldCaches.delete(oldestKey);
  }
  return surface;
}

/** 创建离屏绘制面：优先 OffscreenCanvas，不支持时回退 DOM canvas。 */
function createSurface(width, height) {
  if (typeof OffscreenCanvas === "function") {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      // OffscreenCanvas 构造失败时走 DOM canvas 回退
    }
  }
  if (typeof document === "undefined") return null;
  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  return surface;
}

/** 绘制静态场地：草皮条纹、白线、中圈、罚球区、球门区与点球点（缓存到离屏画布）。 */
function drawStaticField(viewObject) {
  for (let index = 0; index < 12; index += 1) {
    ctx.fillStyle = index % 2 ? "#195b37" : "#216d43";
    projectedPolygon([
      { x: (index / 12) * 100, y: 0 },
      { x: ((index + 1) / 12) * 100, y: 0 },
      { x: ((index + 1) / 12) * 100, y: 100 },
      { x: (index / 12) * 100, y: 100 }
    ], viewObject, true, false);
  }
  ctx.save();
  ctx.strokeStyle = "rgba(244,255,239,.78)";
  ctx.lineWidth = 2.4 * viewObject.scale;
  projectedPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], viewObject, false, true);
  projectedLine(50, 0, 50, 100, viewObject);
  projectedCircle(50, 50, 8.8, 13.2, viewObject);
  projectedBox(0, 20, 17, 60, viewObject);
  projectedBox(83, 20, 17, 60, viewObject);
  projectedBox(0, 37, 6, 26, viewObject);
  projectedBox(94, 37, 6, 26, viewObject);
  projectedDot(11, 50, viewObject);
  projectedDot(89, 50, viewObject);
  ctx.restore();
}

/** 绘制动作事件的球路特效；过期判断统一使用每条特效自己的 durationMs。 */
function drawVisualEffects(viewObject, time) {
  visualEffects = visualEffects.filter((effect) => {
    const duration = Number.isFinite(effect.durationMs) && effect.durationMs > 0 ? effect.durationMs : ACTION_EFFECT_MS;
    return time - effect.startedAt <= duration;
  });
  debugTarget.visualEffectCount = visualEffects.length;
  for (const effect of visualEffects) drawTrajectoryEffect(effect, viewObject, time);
}

/** 绘制单条传球或射门轨迹，射门尾迹按 age 逐渐淡出。 */
function drawTrajectoryEffect(effect, viewObject, time) {
  const trajectory = effect.trajectory;
  if (!trajectory?.start || !trajectory?.end) return;
  const duration = Number.isFinite(effect.durationMs) && effect.durationMs > 0 ? effect.durationMs : ACTION_EFFECT_MS;
  const age = clampView((time - effect.startedAt) / duration, 0, 1);
  const fade = Math.sin(Math.PI * Math.min(age, 1));
  const start = toCanvas(trajectory.start, viewObject);
  const end = toCanvas(trajectory.end, viewObject);
  const highBall = Number(trajectory.height || 0) >= 0.45;
  const shot = ["shot", "goal_shot"].includes(trajectory.kind);
  const color = shot ? "244,208,111" : highBall ? "180,235,255" : "236,255,218";

  ctx.save();
  ctx.globalAlpha = 0.22 + fade * 0.42;
  ctx.strokeStyle = `rgba(${color},${shot ? 0.95 : 0.72})`;
  if (shot) {
    ctx.lineWidth = 6 * end.scale;
    ctx.shadowColor = `rgba(${color},0.95)`;
    ctx.shadowBlur = 16 * end.scale;
  } else {
    ctx.lineWidth = (highBall ? 3 : 2.2) * viewObject.scale;
    ctx.shadowBlur = 0;
  }
  ctx.setLineDash(highBall ? [12 * viewObject.scale, 9 * viewObject.scale] : []);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  // 射门时沿轨迹绘制火花尾迹，增强速度感（按 age 从起点向终点推进）
  if (shot) {
    const sparkCount = 8;
    for (let i = 0; i < sparkCount; i += 1) {
      const t = (age * 1.4 - i * 0.08) % 1;
      if (t < 0 || t > 1) continue;
      const sparkX = lerp(start.x, end.x, t);
      const sparkY = lerp(start.y, end.y, t);
      const sparkSize = (1.2 + Math.sin(time / 60 + i) * 0.6) * end.scale * fade * (1 - t * 0.35);
      ctx.fillStyle = `rgba(255, 220, 120, ${0.7 * fade * (1 - t * 0.4)})`;
      ctx.beginPath();
      ctx.arc(sparkX, sparkY, Math.max(scalePx(0.5), sparkSize), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 0.2 + fade * 0.32;
  ctx.strokeStyle = `rgba(${color},0.58)`;
  ctx.lineWidth = 2 * viewObject.scale;
  ctx.beginPath();
  ctx.ellipse(end.x, end.y + 5 * end.scale, 15 * end.scale, 5 * end.scale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 绘制提前量传球的落点，只是接应提示，不是第二颗球。 */
function drawReceptionTarget(ball, viewObject, time = performance.now()) {
  if (!ball?.inFlight || ball.receptionMode !== "into_space") return;
  if (!Number.isFinite(ball.targetX) || !Number.isFinite(ball.targetY)) return;
  const point = toCanvas({ x: ball.targetX, y: ball.targetY }, viewObject);
  const pulse = 0.5 + Math.sin(time / 160) * 0.5;
  ctx.save();
  ctx.globalAlpha = 0.42 + pulse * 0.22;
  ctx.strokeStyle = "rgba(244,208,111,.82)";
  ctx.lineWidth = Math.max(scalePx(1.4), 2.2 * point.scale);
  ctx.setLineDash([5 * point.scale, 5 * point.scale]);
  ctx.beginPath();
  ctx.ellipse(point.x, point.y + 3 * point.scale, 14 * point.scale, 5 * point.scale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** 绘制球员：姿态来自速度驱动的 pose，镜像/倾斜只作用于身体，号码在镜像变换之外绘制。 */
function drawPlayer(player, side, viewObject, state, isHolder = false, time = performance.now(), isPassReceiver = false, tracker = livePoseTracker, skipEffects = false) {
  const point = toCanvas(player, viewObject);
  const unit = (player.position === "GK" ? 15.2 : 13.2) * point.scale;
  const pose = tracker.update({
    player,
    side,
    point,
    view: viewObject,
    state,
    time,
    effects: skipEffects ? EMPTY_EFFECTS : visualEffects,
    skipEffects
  });
  const jumpOffset = (pose.jump || 0) * point.scale;
  const shadowShrink = Math.max(0.45, 1 - (pose.jump || 0) / 24);
  ctx.save();
  // 落地阴影用预渲染贴图，替代每个球员一次 ctx.shadowBlur（22 个球员每帧省 22 次模糊）
  drawPlayerShadow(point, unit, shadowShrink);
  ctx.translate(point.x, point.y);
  ctx.save();
  // 朝向表现：左右镜像 + 小幅倾斜（tilt 已在姿态层换算到镜像后的局部坐标系）
  ctx.scale(pose.facing || 1, 1);
  ctx.rotate(pose.tilt || 0);
  ctx.translate(0, -unit * 1.46 - jumpOffset);
  drawMascotLimbs(unit, pose, side, player.position === "GK");
  drawMascotBody(unit, pose, side, player.position === "GK");
  drawMascotHead(unit, pose, side);
  ctx.restore();
  // 号码必须在镜像/旋转之外绘制，否则会出现反字
  ctx.save();
  ctx.translate(0, -unit * 1.46 - jumpOffset);
  ctx.fillStyle = playerKitPalette(side, player.position === "GK").number;
  ctx.font = playerFont(Math.max(scalePx(8), 8.8 * point.scale));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(player.shirt, 0, unit * 0.02);
  ctx.restore();
  if (isHolder) {
    ctx.strokeStyle = "rgba(244,208,111,.72)";
    ctx.lineWidth = scalePx(2);
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.06, unit * 1.42, unit * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (isPassReceiver) {
    ctx.strokeStyle = "rgba(180,235,255,.72)";
    ctx.lineWidth = scalePx(1.8);
    ctx.setLineDash([4 * point.scale, 4 * point.scale]);
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.08, unit * 1.26, unit * 0.36, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** 绘制球员落地阴影：把预渲染的径向渐变贴图按球员尺寸缩放后 drawImage。 */
function drawPlayerShadow(point, unit, shadowShrink) {
  const sprite = shadowSpriteCanvas();
  const radiusX = unit * 1.12 * shadowShrink;
  const radiusY = unit * 0.28 * shadowShrink;
  const centerY = point.y + unit * 0.1;
  if (!sprite) {
    // 极端环境（无离屏画布）兜底：退化为纯色椭圆
    ctx.fillStyle = "rgba(0,0,0,.26)";
    ctx.beginPath();
    ctx.ellipse(point.x, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.drawImage(sprite, point.x - radiusX, centerY - radiusY, radiusX * 2, radiusY * 2);
}

/** 惰性创建阴影贴图：128x48 的椭圆径向渐变，只渲染一次。 */
function shadowSpriteCanvas() {
  if (shadowSprite) return shadowSprite;
  const surface = createSurface(SHADOW_SPRITE_WIDTH, SHADOW_SPRITE_HEIGHT);
  if (!surface) return null;
  const spriteCtx = surface.getContext("2d");
  if (!spriteCtx) return null;
  const centerX = SHADOW_SPRITE_WIDTH / 2;
  const radius = centerX - 2;
  spriteCtx.save();
  // 在纵向压缩的坐标系里画圆形渐变，得到椭圆阴影
  spriteCtx.scale(1, SHADOW_SPRITE_HEIGHT / SHADOW_SPRITE_WIDTH);
  const gradient = spriteCtx.createRadialGradient(centerX, SHADOW_SPRITE_WIDTH / 2, 1, centerX, SHADOW_SPRITE_WIDTH / 2, radius);
  gradient.addColorStop(0, "rgba(0,0,0,.34)");
  gradient.addColorStop(0.55, "rgba(0,0,0,.24)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  spriteCtx.fillStyle = gradient;
  spriteCtx.fillRect(0, 0, SHADOW_SPRITE_WIDTH, SHADOW_SPRITE_WIDTH);
  spriteCtx.restore();
  shadowSprite = surface;
  return surface;
}

/** 号码字体：字号量化到 0.5px 后缓存，避免每帧为 22 个球员拼接字体字符串。 */
function playerFont(fontSize) {
  const quantized = Math.max(5, Math.round(fontSize * 2) / 2);
  let font = fontCache.get(quantized);
  if (!font) {
    if (fontCache.size > 64) fontCache.clear();
    font = `bold ${quantized}px Segoe UI`;
    fontCache.set(quantized, font);
  }
  return font;
}

/** 绘制小人仔四肢；臂/腿相位来自速度驱动的 pose，动作姿态作为叠加。 */
function drawMascotLimbs(unit, pose, side, goalkeeper = false) {
  const palette = playerKitPalette(side, goalkeeper);
  const sock = goalkeeper ? palette.trim : side === "home" ? "rgba(196,239,255,.96)" : "rgba(255,214,209,.96)";
  const outline = "rgba(7,15,16,.78)";
  const step = pose.leg || 0;
  const kick = pose.kick || 0;
  const arm = pose.arm || 0;
  const armSwing = pose.armSwing || 0;
  const crouch = pose.crouch || 0;
  const directionX = pose.dirX ?? Math.cos(pose.angle || 0);
  const directionY = pose.dirY ?? Math.sin(pose.angle || 0);
  const leftSwing = Math.max(armSwing, 0);
  const rightSwing = Math.max(-armSwing, 0);
  const hipY = unit * (0.44 + crouch * 0.42);
  const shoulderY = -unit * 0.34;
  const footY = unit * (1.52 - crouch * 0.16);
  const leftFoot = { x: -unit * (0.38 + Math.max(step, 0) * 0.55), y: footY - Math.max(-step, 0) * unit * 0.28 };
  const rightFoot = {
    x: unit * (0.38 + Math.max(-step, 0) * 0.55) + directionX * kick * unit * 0.96,
    y: footY - Math.max(step, 0) * unit * 0.28 + directionY * kick * unit * 0.44 - kick * unit * 0.42
  };
  // 双臂：动作幅度（arm）同时抬臂，跑动摆臂（armSwing）左右反相叠加
  const leftHand = { x: -unit * (0.82 + arm * 0.2 + leftSwing * 0.16), y: shoulderY + unit * (0.76 - arm * 0.62 - leftSwing * 0.5) };
  const rightHand = { x: unit * (0.82 + arm * 0.2 + rightSwing * 0.16), y: shoulderY + unit * (0.72 - arm * 0.62 - rightSwing * 0.5) };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(scalePx(2.8), unit * 0.2);
  ctx.strokeStyle = outline;
  drawBentLimb(-unit * 0.24, hipY, -unit * 0.42, unit * 0.98, leftFoot.x, leftFoot.y);
  drawBentLimb(unit * 0.24, hipY, unit * 0.42 + directionX * kick * unit * 0.44, unit * (0.96 - kick * 0.22), rightFoot.x, rightFoot.y);
  drawBentLimb(-unit * 0.48, shoulderY, -unit * 0.68, unit * 0.12 - (arm + leftSwing) * unit * 0.28, leftHand.x, leftHand.y);
  drawBentLimb(unit * 0.48, shoulderY, unit * 0.68, unit * 0.08 - (arm + rightSwing) * unit * 0.2, rightHand.x, rightHand.y);
  ctx.strokeStyle = sock;
  ctx.lineWidth = Math.max(scalePx(1.5), unit * 0.1);
  drawBentLimb(-unit * 0.24, hipY, -unit * 0.42, unit * 0.98, leftFoot.x, leftFoot.y);
  drawBentLimb(unit * 0.24, hipY, unit * 0.42 + directionX * kick * unit * 0.44, unit * (0.96 - kick * 0.22), rightFoot.x, rightFoot.y);
  if (goalkeeper) {
    ctx.fillStyle = palette.glove;
    ctx.strokeStyle = "rgba(8,18,20,.72)";
    ctx.lineWidth = Math.max(scalePx(1), unit * 0.08);
    drawKeeperGlove(leftHand.x, leftHand.y, unit);
    drawKeeperGlove(rightHand.x, rightHand.y, unit);
  }
  ctx.restore();
}

/** 绘制门将手套。 */
function drawKeeperGlove(x, y, unit) {
  ctx.beginPath();
  roundedRect(x - unit * 0.18, y - unit * 0.13, unit * 0.36, unit * 0.26, unit * 0.08);
  ctx.fill();
  ctx.stroke();
}

/** 绘制小人仔身体和球衣。 */
function drawMascotBody(unit, pose, side, goalkeeper = false) {
  const palette = playerKitPalette(side, goalkeeper);
  const facing = pose.facing || 1;
  ctx.save();
  ctx.translate((pose.dirX || 0) * (pose.lean || 0) * unit * 0.22, (pose.crouch || 0) * unit * 0.28);
  // 动作前倾同样按镜像方向换算，保证左右朝向时前倾方向一致
  ctx.rotate(facing * (pose.lean || 0) * 0.16);
  ctx.beginPath();
  ctx.fillStyle = palette.kit;
  roundedRect(-unit * (0.55 + pose.stretch * 0.1), -unit * 0.62, unit * (1.1 + pose.stretch * 0.18), unit * (1.18 - pose.stretch * 0.08), unit * 0.22);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = palette.accent;
  if (goalkeeper) {
    ctx.moveTo(-unit * 0.62, -unit * 0.58);
    ctx.lineTo(-unit * 0.28, -unit * 0.58);
    ctx.lineTo(unit * 0.62, unit * 0.46);
    ctx.lineTo(unit * 0.2, unit * 0.46);
    ctx.closePath();
  } else {
    ctx.rect(-unit * 0.48, -unit * 0.54, unit * 0.18, unit * 0.92);
  }
  ctx.fill();
  ctx.lineWidth = Math.max(scalePx(1.2), unit * 0.12);
  ctx.strokeStyle = "rgba(8,18,20,.82)";
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = palette.shorts;
  ctx.rect(-unit * 0.52, unit * 0.36, unit * 1.04, unit * 0.32);
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = palette.trim;
  ctx.lineWidth = Math.max(scalePx(1.1), unit * 0.1);
  ctx.moveTo(-unit * 0.42, -unit * 0.2);
  ctx.lineTo(unit * 0.42, -unit * 0.2);
  ctx.stroke();
  ctx.restore();
}

/** 主客队/门将的球衣配色表。 */
function playerKitPalette(side, goalkeeper = false) {
  if (goalkeeper) {
    return side === "home"
      ? { kit: "#7c3cff", trim: "#f7fbff", accent: "#00d9ff", shorts: "rgba(20,6,56,.48)", number: "#ffffff", glove: "#f7fbff" }
      : { kit: "#b7ff1a", trim: "#10220a", accent: "#ff3b30", shorts: "rgba(19,55,8,.38)", number: "#10220a", glove: "#f7fbff" };
  }
  return side === "home"
    ? { kit: "#58c7ff", trim: "#d8f6ff", accent: "rgba(6,16,24,.16)", shorts: "rgba(6,16,24,.2)", number: "#061018" }
    : { kit: "#ff746b", trim: "#ffe0dc", accent: "rgba(50,8,6,.14)", shorts: "rgba(50,8,6,.18)", number: "#220502" };
}

/** 绘制小人仔头部和朝向（头部按朝向做少量偏移，增强转头感）。 */
function drawMascotHead(unit, pose, side) {
  const skin = side === "home" ? "#f4dcc3" : "#ffd2bd";
  ctx.save();
  ctx.translate((pose.dirX || 0) * unit * 0.2 + (pose.tilt || 0) * unit * 0.5, -unit * (1.12 - (pose.crouch || 0) * 0.12));
  ctx.beginPath();
  ctx.fillStyle = skin;
  ctx.arc(0, 0, unit * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(scalePx(1), unit * 0.1);
  ctx.strokeStyle = "rgba(8,18,20,.74)";
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = "rgba(69,43,26,.9)";
  ctx.arc(-unit * 0.04, -unit * 0.1, unit * 0.34, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = "rgba(8,18,20,.72)";
  ctx.arc(unit * 0.11, -unit * 0.04, unit * 0.04, 0, Math.PI * 2);
  ctx.arc(-unit * 0.08, -unit * 0.04, unit * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 绘制带关节的折线肢体（髋/肩 → 膝/肘 → 脚/手）。 */
function drawBentLimb(x1, y1, x2, y2, x3, y3) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.stroke();
}

/** 绘制两段直线肢体（保留给简单线条使用）。 */
function drawLimb(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** 在路径中追加圆角矩形。 */
function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

/** 绘制足球；红色残影只用于引擎确认的射门飞行，不再按“最近有射门特效”推断。 */
function drawBall(ball, viewObject, time = performance.now(), skipEffects = false) {
  const point = toCanvas(ball, viewObject);
  const air = activeBallAirHeight(ball, time, skipEffects);
  const lift = (scalePx(10) + 30 * point.scale) * air;
  const ballY = point.y - lift;
  const radius = (5.2 + air * 4.4) * point.scale;
  const shadowScale = 1 - air * 0.58;
  // 红球判定：inFlight + flightKind 表明这是真实射门飞行，避免持球后球还发红
  const isShot = Boolean(ball?.inFlight && ["shot", "goal_shot"].includes(ball.flightKind));

  ctx.save();
  // 射门时绘制流星般的红色残影尾迹
  if (isShot && Number.isFinite(ball.flightStartX)) {
    const start = { x: ball.flightStartX, y: ball.flightStartY };
    const end = { x: ball.flightEndX, y: ball.flightEndY };
    const progress = clampView(trajectoryProgress(ball, start, end), 0, 1);
    const trailLength = 5;
    for (let i = 1; i <= trailLength; i += 1) {
      const ratio = i / (trailLength + 1);
      const trailProgress = Math.max(0, progress - ratio * 0.18);
      const trailX = lerp(start.x, end.x, trailProgress);
      const trailY = lerp(start.y, end.y, trailProgress);
      const trailPoint = toCanvas({ x: trailX, y: trailY }, viewObject);
      const trailAir = Number(ball.flightHeight || 0) * Math.sin(Math.PI * trailProgress);
      const trailLift = (scalePx(10) + 30 * trailPoint.scale) * trailAir;
      const trailCanvasY = trailPoint.y - trailLift;
      const trailRadius = radius * (1 - ratio * 0.35);
      const opacity = 0.45 * (1 - ratio);
      ctx.fillStyle = `rgba(255, 59, 48, ${opacity})`;
      ctx.shadowColor = "rgba(255, 59, 48, 0.7)";
      ctx.shadowBlur = scalePx(10) * (1 - ratio);
      ctx.beginPath();
      ctx.arc(trailPoint.x, trailCanvasY, Math.max(scalePx(0.5), trailRadius), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  ctx.fillStyle = `rgba(0,0,0,${0.34 - air * 0.16})`;
  ctx.beginPath();
  ctx.ellipse(point.x, point.y + radius * 0.32, radius * 1.22 * shadowScale, radius * 0.38 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();
  if (air > 0.08) {
    ctx.strokeStyle = `rgba(248,245,233,${0.12 + air * 0.24})`;
    ctx.lineWidth = Math.max(scalePx(1), 1.5 * point.scale);
    ctx.setLineDash([3 * point.scale, 4 * point.scale]);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, ballY + radius * 0.72);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.shadowColor = isShot ? `rgba(255, 59, 48, ${0.9 + air * 0.08})` : `rgba(248,245,233,${0.55 + air * 0.28})`;
  ctx.shadowBlur = isShot ? scalePx(20 + air * 22) : scalePx(8 + air * 14);
  ctx.beginPath();
  ctx.fillStyle = isShot ? "#ff3b30" : "#f8f5e9";
  ctx.arc(point.x, ballY, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = isShot ? "#7a0b00" : "#111";
  ctx.lineWidth = scalePx(1.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = isShot ? "#5c0800" : "#111";
  ctx.arc(point.x + radius * 0.25, ballY - radius * 0.25, radius * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 返回当前真实足球在活跃球路上的视觉离地高度；回放不读实时特效。 */
function activeBallAirHeight(ball, time = performance.now(), skipEffects = false) {
  if (!ball) return 0;
  if (ball.inFlight && Number.isFinite(ball.flightHeight) && Number.isFinite(ball.flightStartX) && Number.isFinite(ball.flightEndX)) {
    const start = { x: ball.flightStartX, y: ball.flightStartY };
    const end = { x: ball.flightEndX, y: ball.flightEndY };
    const progress = clampView(trajectoryProgress(ball, start, end), 0, 1);
    const arc = Math.sin(Math.PI * progress);
    return clampView(Number(ball.flightHeight || 0) * arc, 0, 1);
  }
  if (skipEffects) return 0;
  let air = 0;
  for (const effect of visualEffects) {
    const trajectory = effect.trajectory;
    const baseHeight = Number(trajectory?.height || 0);
    if (baseHeight < 0.45 || !trajectory?.start || !trajectory?.end) continue;
    const duration = Number.isFinite(effect.durationMs) && effect.durationMs > 0 ? effect.durationMs : ACTION_EFFECT_MS;
    const age = clampView((time - effect.startedAt) / duration, 0, 1);
    const progress = trajectoryProgress(ball, trajectory.start, trajectory.end);
    const laneGap = distanceToSegment(ball, trajectory.start, trajectory.end);
    if (progress < 0 || progress > 1 || laneGap > 5.5) continue;
    const timeFade = Math.sin(Math.PI * age);
    const flightArc = Math.sin(Math.PI * progress);
    air = Math.max(air, baseHeight * timeFade * flightArc);
  }
  return clampView(air, 0, 1);
}

/** 从百分比坐标转换为当前视图的 CSS 像素坐标（scale 已包含视图缩放）。 */
function toCanvas(point, viewObject) {
  const width = viewObject.width;
  const height = viewObject.height;
  const depth = clampView((point?.y ?? 50) / 100, 0, 1);
  const topY = height * 0.13;
  const bottomY = height * 0.86;
  const left = lerp(width * 0.16, width * 0.07, depth);
  const right = lerp(width * 0.84, width * 0.93, depth);
  const x = left + ((point?.x ?? 50) / 100) * (right - left);
  const y = lerp(topY, bottomY, depth);
  return { x, y, depth, scale: lerp(0.72, 1.18, depth) * (viewObject.scale || 1) };
}

/** 复制绘制状态，避免插值时修改服务端快照。 */
export function cloneDrawState(state) {
  return { ...state, teams: { home: { ...state.teams.home, players: state.teams.home.players.map((player) => ({ ...player })) }, away: { ...state.teams.away, players: state.teams.away.players.map((player) => ({ ...player })) } }, ball: state.ball ? { ...state.ball } : null };
}

/** 把百分比坐标多边形投影到画布并填充/描边。 */
function projectedPolygon(points, viewObject, fill = false, stroke = true) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const projected = toCanvas(point, viewObject);
    if (index === 0) ctx.moveTo(projected.x, projected.y);
    else ctx.lineTo(projected.x, projected.y);
  });
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

/** 把百分比坐标线段投影到画布并描边（中线等）。 */
function projectedLine(x1, y1, x2, y2, viewObject) {
  const start = toCanvas({ x: x1, y: y1 }, viewObject);
  const end = toCanvas({ x: x2, y: y2 }, viewObject);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

/** 把百分比坐标矩形投影到画布并描边（罚球区/球门区）。 */
function projectedBox(x, y, w, h, viewObject) {
  projectedPolygon([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], viewObject, false, true);
}

/** 把百分比坐标椭圆投影到画布并描边（中圈）。 */
function projectedCircle(x, y, rx, ry, viewObject) {
  ctx.beginPath();
  for (let index = 0; index <= 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2;
    const point = toCanvas({ x: x + Math.cos(angle) * rx, y: y + Math.sin(angle) * ry }, viewObject);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

/** 绘制点球点：半径 1.8、透明度 .35，明显小于足球，避免远看像第三颗球。 */
function projectedDot(x, y, viewObject, radiusScale = PENALTY_SPOT_RADIUS, alpha = PENALTY_SPOT_ALPHA) {
  const point = toCanvas({ x, y }, viewObject);
  ctx.beginPath();
  ctx.arc(point.x, point.y, radiusScale * point.scale, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(246,255,245,${alpha})`;
  ctx.fill();
}

/** 计算点在球路方向上的投影进度（0 为起点，1 为终点）。 */
function trajectoryProgress(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return 0;
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
}

/** 计算点到球路线段的垂直距离，用于判断球是否在同一条球路上。 */
function distanceToSegment(point, start, end) {
  const progress = clampView(trajectoryProgress(point, start, end), 0, 1);
  const x = lerp(start.x, end.x, progress);
  const y = lerp(start.y, end.y, progress);
  return Math.hypot((point.x ?? 0) - x, (point.y ?? 0) - y);
}

/** 绘制球门：2.5D 框架 + 球网，进球时高亮球网并产生鼓包回弹。 */
function drawGoal(x, y, side, viewObject, state = null, time = performance.now(), effects = EMPTY_EFFECTS) {
  const backX = x + side * 5.2;
  const top = y - 11;
  const bottom = y + 11;
  const frontTop = toCanvas({ x, y: top }, viewObject);
  const frontBottom = toCanvas({ x, y: bottom }, viewObject);
  const backTop = toCanvas({ x: backX, y: top }, viewObject);
  const backBottom = toCanvas({ x: backX, y: bottom }, viewObject);
  const postScale = (frontTop.scale + frontBottom.scale + backTop.scale + backBottom.scale) / 4;
  const goalHeight = 24 * postScale;

  const raised = (point) => ({ x: point.x, y: point.y - goalHeight });
  const frontTopHigh = raised(frontTop);
  const frontBottomHigh = raised(frontBottom);

  // 进球时高亮球门网，并产生球被击中网后的自然回弹动画
  let netFill = "rgba(244,208,111,.08)";
  let netStroke = "rgba(244,255,239,.18)";
  let netGlow = null;
  let bulgeX = 0;
  let bulgeY = 0;
  if (state?.state === "goal_scored" && Math.abs((state.ball?.x ?? -999) - x) < 10) {
    const goalEffect = effects.find((effect) => effect.type === "goal");
    const duration = Number.isFinite(goalEffect?.durationMs) && goalEffect.durationMs > 0 ? goalEffect.durationMs : GOAL_EFFECT_MS;
    const age = goalEffect ? clampView((time - goalEffect.startedAt) / duration, 0, 1) : 0.5;
    const decay = Math.max(0, 1 - age);
    const impact = Math.sin(Math.PI * age) * decay;
    bulgeX = side * impact * 2.8 * postScale;
    bulgeY = Math.sin(age * Math.PI * 3) * impact * 0.8 * postScale;
    const highlight = 0.3 * decay;
    netFill = `rgba(255, 215, 0, ${0.08 + highlight})`;
    netStroke = `rgba(255, 215, 0, ${0.18 + highlight * 2})`;
    netGlow = `rgba(255, 215, 0, ${0.4 * decay})`;
  }

  const backTopHigh = raised({ x: backTop.x + bulgeX, y: backTop.y + bulgeY });
  const backBottomHigh = raised({ x: backBottom.x + bulgeX, y: backBottom.y + bulgeY });
  const backTopBulged = { x: backTop.x + bulgeX, y: backTop.y + bulgeY };
  const backBottomBulged = { x: backBottom.x + bulgeX, y: backBottom.y + bulgeY };

  ctx.save();
  if (netGlow) {
    ctx.shadowColor = netGlow;
    ctx.shadowBlur = 14 * postScale;
  }
  drawGoalNetPanel([frontTop, frontBottom, backBottomBulged, backTopBulged], netFill, netStroke);
  drawGoalNetPanel([frontTopHigh, frontBottomHigh, backBottomHigh, backTopHigh], netFill, netStroke);
  drawGoalNetPanel([frontTop, frontTopHigh, backTopHigh, backTopBulged], netFill, netStroke);
  drawGoalNetPanel([frontBottom, frontBottomHigh, backBottomHigh, backBottomBulged], netFill, netStroke);
  drawGoalNetPanel([backTopBulged, backTopHigh, backBottomHigh, backBottomBulged], netFill, netStroke);
  ctx.shadowBlur = 0;

  ctx.strokeStyle = "rgba(244,255,239,.28)";
  ctx.lineWidth = Math.max(scalePx(1), 1.15 * postScale);
  for (let index = 1; index < 4; index += 1) {
    const amount = index / 4;
    drawGoalFrameLine(lerpPoint(frontTop, backTopBulged, amount), lerpPoint(frontBottom, backBottomBulged, amount));
    drawGoalFrameLine(lerpPoint(frontTopHigh, backTopHigh, amount), lerpPoint(frontBottomHigh, backBottomHigh, amount));
  }
  for (let index = 1; index < 3; index += 1) {
    const amount = index / 3;
    drawGoalFrameLine(lerpPoint(frontTop, frontBottom, amount), lerpPoint(backTopBulged, backBottomBulged, amount));
    drawGoalFrameLine(lerpPoint(frontTopHigh, frontBottomHigh, amount), lerpPoint(backTopHigh, backBottomHigh, amount));
  }

  ctx.strokeStyle = "rgba(248,252,239,.96)";
  ctx.lineWidth = Math.max(scalePx(2.2), 3.2 * postScale);
  ctx.lineCap = "round";
  drawGoalFrameLine(frontTop, frontTopHigh);
  drawGoalFrameLine(frontBottom, frontBottomHigh);
  drawGoalFrameLine(frontTopHigh, frontBottomHigh);
  drawGoalFrameLine(backTopBulged, backTopHigh);
  drawGoalFrameLine(backBottomBulged, backBottomHigh);
  drawGoalFrameLine(backTopHigh, backBottomHigh);
  drawGoalFrameLine(frontTopHigh, backTopHigh);
  drawGoalFrameLine(frontBottomHigh, backBottomHigh);
  ctx.restore();
}

/** 绘制一块球网面板。 */
function drawGoalNetPanel(points, fillStyle, strokeStyle) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = scalePx(1);
  ctx.stroke();
}

/** 绘制一条球门框架线。 */
function drawGoalFrameLine(start, end) {
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

/** 两点之间线性插值，返回新的点对象。 */
function lerpPoint(start, end, amount) {
  return { x: lerp(start.x, end.x, amount), y: lerp(start.y, end.y, amount) };
}

/** 线性插值。 */
function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

/** 数值裁剪到 [min, max]。 */
function clampView(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 记录实时状态切换：从 goal_scored/var_check 变成 kickoff 时启动重开球遮罩。 */
function updateKickoffFlash(state, time) {
  const nextState = state?.state ?? null;
  if (lastLiveMatchState && KICKOFF_FLASH_FROM_STATES.includes(lastLiveMatchState) && nextState === "kickoff") {
    kickoffFlash = { startedAt: time };
  }
  lastLiveMatchState = nextState;
}

/** 绘制重开球过渡的白色遮罩（200ms 线性淡出，画在球场之上、球员之下）。 */
function drawKickoffFlash(viewObject, time) {
  if (!kickoffFlash) return;
  const age = (time - kickoffFlash.startedAt) / KICKOFF_FLASH_MS;
  if (age < 0 || age > 1) {
    kickoffFlash = null;
    return;
  }
  ctx.save();
  ctx.fillStyle = `rgba(255,255,255,${KICKOFF_FLASH_ALPHA * (1 - age)})`;
  ctx.fillRect(0, 0, viewObject.width, viewObject.height);
  ctx.restore();
}

/** 构造演示用场地状态：服务端还没有比赛数据时的占位画面。 */
export function mockState() {
  const make = (side, mirror) => ({ players: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, shirt: index + 1, x: mirror ? 100 - [7,21,24,24,21,40,42,40,61,64,61][index] : [7,21,24,24,21,40,42,40,61,64,61][index], y: [50,22,40,60,78,34,50,66,24,50,76][index] })), tactics: { intent: side === "home" ? "high_press" : "compact_block" } });
  return { ball: { x: 50, y: 50 }, teams: { home: make("home", false), away: make("away", true) } };
}
