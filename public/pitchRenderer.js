let canvas = null;
let ctx = null;
let debugTarget = {};
let visualEffects = [];
const seenVisualEffectIds = new Set();

const VISUAL_EFFECT_MS = 1600;
const ACTION_EFFECT_MS = 900;
const PLAYER_ACTION_SYSTEM = {
  idle: { lean: 0, stretch: 0, leg: 0.08, arm: 0.08, kick: 0, crouch: 0 },
  run: { lean: 0.18, stretch: 0.22, leg: 0.48, arm: 0.38, kick: 0, crouch: 0.02 },
  pass: { lean: 0.28, stretch: 0.42, leg: 0.16, arm: 0.26, kick: 0.86, crouch: 0.02 },
  receive: { lean: -0.08, stretch: 0.2, leg: 0.2, arm: 0.34, kick: 0.18, crouch: 0.04 },
  shot: { lean: 0.34, stretch: 0.5, leg: 0.14, arm: 0.44, kick: 1.12, crouch: 0.02 },
  tackle: { lean: 0.42, stretch: 0.5, leg: 0.12, arm: 0.28, kick: 1.18, crouch: 0.18 },
  foul: { lean: 0.2, stretch: 0.22, leg: 0.12, arm: 0.66, kick: 0.54, crouch: 0.12 },
  celebrate: { lean: -0.14, stretch: 0.26, leg: 0.18, arm: 0.92, kick: 0.22, crouch: 0 }
};

export function initPitchRenderer(targetCanvas, debug = {}) {
  canvas = targetCanvas;
  ctx = canvas.getContext("2d");
  debugTarget = debug || {};
}

export function clearVisualEffects() {
  visualEffects = [];
  seenVisualEffectIds.clear();
  debugTarget.visualEffectCount = 0;
}

export function queueVisualEffect(event, recentEvents = []) {
  if (!event?.action_event_id || seenVisualEffectIds.has(event.action_event_id)) return;
  if (!event.trajectory && !event.actor && !event.target) return;
  seenVisualEffectIds.add(event.action_event_id);
  visualEffects.push({ id: event.action_event_id, type: event.action_type, actor: event.actor, target: event.target, trajectory: event.trajectory, startedAt: performance.now() });
  if (seenVisualEffectIds.size > 80) {
    const keep = new Set(recentEvents.map((item) => item.action_event_id).filter(Boolean));
    for (const id of seenVisualEffectIds) if (!keep.has(id)) seenVisualEffectIds.delete(id);
  }
}

export function drawPitch(state, time = performance.now()) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  drawField(width, height);
  drawVisualEffects(width, height, time);
  const drawState = state || mockState();
  drawReceptionTarget(drawState.ball, width, height, time);
  const players = ["home", "away"]
    .flatMap((side) => drawState.teams[side].players.map((player) => ({ player, side })))
    .sort((left, right) => left.player.y - right.player.y);
  for (const { player, side } of players) {
    const isPassReceiver = drawState.ball?.pendingHolderTeam === side && drawState.ball?.pendingHolderId === player.id;
    const isHolder = !drawState.ball?.inFlight && drawState.ball?.holderTeam === side && drawState.ball?.holderId === player.id;
    drawPlayer(player, side, width, height, isHolder, time, isPassReceiver);
  }
  drawBall(drawState.ball, width, height, time);
}

/** 绘制动作事件的球路特效。 */
function drawVisualEffects(width, height, time) {
  visualEffects = visualEffects.filter((effect) => time - effect.startedAt <= VISUAL_EFFECT_MS);
  debugTarget.visualEffectCount = visualEffects.length;
  for (const effect of visualEffects) drawTrajectoryEffect(effect, width, height, time);
}

/** 绘制单条传球或射门轨迹。 */
function drawTrajectoryEffect(effect, width, height, time) {
  const trajectory = effect.trajectory;
  if (!trajectory?.start || !trajectory?.end) return;
  const age = clampView((time - effect.startedAt) / VISUAL_EFFECT_MS, 0, 1);
  const fade = Math.sin(Math.PI * Math.min(age, 1));
  const start = toCanvas(trajectory.start, width, height);
  const end = toCanvas(trajectory.end, width, height);
  const highBall = Number(trajectory.height || 0) >= 0.45;
  const shot = ["shot", "goal_shot"].includes(trajectory.kind);
  const color = shot ? "244,208,111" : highBall ? "180,235,255" : "236,255,218";

  ctx.save();
  ctx.globalAlpha = 0.22 + fade * 0.42;
  ctx.strokeStyle = `rgba(${color},${shot ? 0.82 : 0.72})`;
  ctx.lineWidth = shot ? 3.8 : highBall ? 3 : 2.2;
  ctx.setLineDash(highBall ? [12, 9] : []);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha = 0.2 + fade * 0.32;
  ctx.strokeStyle = `rgba(${color},0.58)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(end.x, end.y + 5 * end.scale, 15 * end.scale, 5 * end.scale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 绘制提前量传球的落点，只是接应提示，不是第二颗球。 */
function drawReceptionTarget(ball, width, height, time = performance.now()) {
  if (!ball?.inFlight || ball.receptionMode !== "into_space") return;
  if (!Number.isFinite(ball.targetX) || !Number.isFinite(ball.targetY)) return;
  const point = toCanvas({ x: ball.targetX, y: ball.targetY }, width, height);
  const pulse = 0.5 + Math.sin(time / 160) * 0.5;
  ctx.save();
  ctx.globalAlpha = 0.42 + pulse * 0.22;
  ctx.strokeStyle = "rgba(244,208,111,.82)";
  ctx.lineWidth = Math.max(1.4, 2.2 * point.scale);
  ctx.setLineDash([5 * point.scale, 5 * point.scale]);
  ctx.beginPath();
  ctx.ellipse(point.x, point.y + 3 * point.scale, 14 * point.scale, 5 * point.scale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** 绘制场地。 */
function drawField(width, height) {
  for (let index = 0; index < 12; index += 1) {
    ctx.fillStyle = index % 2 ? "#195b37" : "#216d43";
    projectedPolygon([
      { x: (index / 12) * 100, y: 0 },
      { x: ((index + 1) / 12) * 100, y: 0 },
      { x: ((index + 1) / 12) * 100, y: 100 },
      { x: (index / 12) * 100, y: 100 }
    ], width, height, true, false);
  }
  ctx.save();
  ctx.strokeStyle = "rgba(244,255,239,.78)";
  ctx.lineWidth = 2.4;
  projectedPolygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], width, height, false, true);
  projectedLine(50, 0, 50, 100, width, height);
  projectedCircle(50, 50, 8.8, 13.2, width, height);
  projectedBox(0, 20, 17, 60, width, height);
  projectedBox(83, 20, 17, 60, width, height);
  projectedBox(0, 37, 6, 26, width, height);
  projectedBox(94, 37, 6, 26, width, height);
  projectedDot(11, 50, width, height);
  projectedDot(89, 50, width, height);
  drawGoal(0, 50, -1, width, height);
  drawGoal(100, 50, 1, width, height);
  ctx.restore();
}

/** 绘制球员。 */
function drawPlayer(player, side, width, height, isHolder = false, time = performance.now(), isPassReceiver = false) {
  const point = toCanvas(player, width, height);
  const unit = (player.position === "GK" ? 15.2 : 13.2) * point.scale;
  const pose = playerPose(player, side, width, height, time);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.beginPath();
  ctx.ellipse(point.x, point.y + unit * 0.1, unit * 1.12, unit * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(point.x, point.y);
  ctx.shadowColor = "rgba(0,0,0,.42)";
  ctx.shadowBlur = 8 * point.scale;
  ctx.save();
  ctx.translate(0, -unit * 1.46);
  drawMascotLimbs(unit, pose, side, player.position === "GK");
  drawMascotBody(unit, pose, side, player.position === "GK");
  drawMascotHead(unit, pose, side);
  ctx.shadowBlur = 0;
  const palette = playerKitPalette(side, player.position === "GK");
  ctx.fillStyle = palette.number;
  ctx.font = `bold ${Math.max(8, 8.8 * point.scale)}px Segoe UI`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(player.shirt, 0, unit * 0.02);
  ctx.restore();
  if (isHolder) {
    ctx.strokeStyle = "rgba(244,208,111,.72)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.06, unit * 1.42, unit * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (isPassReceiver) {
    ctx.strokeStyle = "rgba(180,235,255,.72)";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4 * point.scale, 4 * point.scale]);
    ctx.beginPath();
    ctx.ellipse(0, unit * 0.08, unit * 1.26, unit * 0.36, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** 返回球员当前姿态。 */
function playerPose(player, side, width, height, time = performance.now()) {
  const action = activePlayerAction(player, side, time);
  const base = movementPose(player, width, height, time);
  if (!action) return base;
  const pulse = Math.sin(Math.PI * action.age);
  const actionAngle = action.angle ?? base.angle;
  const actionKey = playerActionKey(action);
  const actionSpec = PLAYER_ACTION_SYSTEM[actionKey] || PLAYER_ACTION_SYSTEM.idle;
  const receiving = action.role === "target";
  return {
    angle: receiving ? actionAngle + Math.PI : actionAngle,
    actionKey,
    lean: actionSpec.lean * pulse,
    stretch: Math.max(base.stretch, actionSpec.stretch * pulse),
    kick: receiving ? 0.22 * pulse : actionSpec.kick * pulse,
    arm: actionSpec.arm * pulse,
    leg: Math.max(base.leg || 0, actionSpec.leg * pulse),
    crouch: actionSpec.crouch * pulse,
    run: base.run * (1 - pulse * 0.5),
    role: action.role,
    type: action.type
  };
}

/** 普通跑动姿态。 */
function movementPose(player, width, height, time = performance.now()) {
  const point = toCanvas(player, width, height);
  const target = toCanvas({ x: player.targetX ?? player.x, y: player.targetY ?? player.y }, width, height);
  const dx = target.x - point.x;
  const dy = target.y - point.y;
  const gap = Math.hypot(dx, dy);
  const moving = gap > 1.2;
  const step = moving ? Math.sin(time / 120 + player.id * 0.7) : 0;
  const spec = moving ? PLAYER_ACTION_SYSTEM.run : PLAYER_ACTION_SYSTEM.idle;
  return {
    angle: moving ? Math.atan2(dy, dx) : -Math.PI / 2,
    actionKey: moving ? "run" : "idle",
    lean: moving ? spec.lean : 0,
    stretch: moving ? clampView(gap / 26, 0.08, spec.stretch) : 0,
    kick: 0,
    arm: Math.abs(step) * spec.arm,
    leg: step * spec.leg,
    crouch: moving ? spec.crouch : 0,
    run: moving ? clampView(gap / 24, 0.15, 0.55) : 0
  };
}

/** 将动作事件映射到小人仔动作系统。 */
function playerActionKey(action) {
  if (action.role === "target" && ["pass_completed", "pass_intercepted"].includes(action.type)) return "receive";
  if (["pass_completed", "pass_intercepted"].includes(action.type)) return "pass";
  if (["shot"].includes(action.type)) return "shot";
  if (["goal"].includes(action.type)) return action.role === "actor" ? "celebrate" : "receive";
  if (["tackle_won"].includes(action.type)) return action.role === "actor" ? "tackle" : "receive";
  if (["foul"].includes(action.type)) return "foul";
  return "idle";
}

/** 最近动作事件对球员产生的姿态。 */
function activePlayerAction(player, side, time = performance.now()) {
  let selected = null;
  for (const effect of visualEffects) {
    const age = (time - effect.startedAt) / ACTION_EFFECT_MS;
    if (age < 0 || age > 1) continue;
    const actorMatch = effect.actor?.team_id === side && effect.actor?.player_id === player.id;
    const targetMatch = effect.target?.team_id === side && effect.target?.player_id === player.id;
    if (!actorMatch && !targetMatch) continue;
    selected = { ...effect, age, role: actorMatch ? "actor" : "target" };
  }
  if (!selected) return null;
  return { ...selected, angle: effectAngle(selected) };
}

function effectAngle(effect) {
  const start = effect.trajectory?.start;
  const end = effect.trajectory?.end;
  if (start && end) return Math.atan2(end.y - start.y, end.x - start.x);
  return effect.actor?.team_id === "away" ? Math.PI : 0;
}

/** 绘制小人仔四肢。 */
function drawMascotLimbs(unit, pose, side, goalkeeper = false) {
  const palette = playerKitPalette(side, goalkeeper);
  const sock = goalkeeper ? palette.trim : side === "home" ? "rgba(196,239,255,.96)" : "rgba(255,214,209,.96)";
  const outline = "rgba(7,15,16,.78)";
  const step = pose.leg || 0;
  const kick = pose.kick || 0;
  const arm = pose.arm || 0;
  const crouch = pose.crouch || 0;
  const directionX = Math.cos(pose.angle || 0);
  const directionY = Math.sin(pose.angle || 0);
  const hipY = unit * (0.44 + crouch * 0.42);
  const shoulderY = -unit * 0.34;
  const footY = unit * (1.52 - crouch * 0.16);
  const leftFoot = { x: -unit * (0.38 + Math.max(step, 0) * 0.55), y: footY - Math.max(-step, 0) * unit * 0.28 };
  const rightFoot = {
    x: unit * (0.38 + Math.max(-step, 0) * 0.55) + directionX * kick * unit * 0.96,
    y: footY - Math.max(step, 0) * unit * 0.28 + directionY * kick * unit * 0.44 - kick * unit * 0.42
  };
  const leftHand = { x: -unit * (0.82 + arm * 0.28), y: shoulderY + unit * (0.76 - arm * 0.78) };
  const rightHand = { x: unit * (0.82 + arm * 0.2), y: shoulderY + unit * (0.72 - arm * 0.62) };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.8, unit * 0.2);
  ctx.strokeStyle = outline;
  drawBentLimb(-unit * 0.24, hipY, -unit * 0.42, unit * 0.98, leftFoot.x, leftFoot.y);
  drawBentLimb(unit * 0.24, hipY, unit * 0.42 + directionX * kick * unit * 0.44, unit * (0.96 - kick * 0.22), rightFoot.x, rightFoot.y);
  drawBentLimb(-unit * 0.48, shoulderY, -unit * 0.68, unit * 0.12 - arm * unit * 0.28, leftHand.x, leftHand.y);
  drawBentLimb(unit * 0.48, shoulderY, unit * 0.68, unit * 0.08 - arm * unit * 0.2, rightHand.x, rightHand.y);
  ctx.strokeStyle = sock;
  ctx.lineWidth = Math.max(1.5, unit * 0.1);
  drawBentLimb(-unit * 0.24, hipY, -unit * 0.42, unit * 0.98, leftFoot.x, leftFoot.y);
  drawBentLimb(unit * 0.24, hipY, unit * 0.42 + directionX * kick * unit * 0.44, unit * (0.96 - kick * 0.22), rightFoot.x, rightFoot.y);
  if (goalkeeper) {
    ctx.fillStyle = palette.glove;
    ctx.strokeStyle = "rgba(8,18,20,.72)";
    ctx.lineWidth = Math.max(1, unit * 0.08);
    drawKeeperGlove(leftHand.x, leftHand.y, unit);
    drawKeeperGlove(rightHand.x, rightHand.y, unit);
  }
  ctx.restore();
}

function drawKeeperGlove(x, y, unit) {
  ctx.beginPath();
  roundedRect(x - unit * 0.18, y - unit * 0.13, unit * 0.36, unit * 0.26, unit * 0.08);
  ctx.fill();
  ctx.stroke();
}

/** 绘制小人仔身体和球衣。 */
function drawMascotBody(unit, pose, side, goalkeeper = false) {
  const palette = playerKitPalette(side, goalkeeper);
  ctx.save();
  ctx.translate(Math.cos(pose.angle || 0) * (pose.lean || 0) * unit * 0.22, pose.crouch * unit * 0.28);
  ctx.rotate((pose.lean || 0) * 0.16);
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
  ctx.lineWidth = Math.max(1.2, unit * 0.12);
  ctx.strokeStyle = "rgba(8,18,20,.82)";
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = palette.shorts;
  ctx.rect(-unit * 0.52, unit * 0.36, unit * 1.04, unit * 0.32);
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = palette.trim;
  ctx.lineWidth = Math.max(1.1, unit * 0.1);
  ctx.moveTo(-unit * 0.42, -unit * 0.2);
  ctx.lineTo(unit * 0.42, -unit * 0.2);
  ctx.stroke();
  ctx.restore();
}

/** 绘制小人仔头部和朝向。 */
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

function drawMascotHead(unit, pose, side) {
  const skin = side === "home" ? "#f4dcc3" : "#ffd2bd";
  ctx.save();
  ctx.translate(Math.cos(pose.angle || 0) * unit * 0.2, -unit * (1.12 - pose.crouch * 0.12));
  ctx.beginPath();
  ctx.fillStyle = skin;
  ctx.arc(0, 0, unit * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, unit * 0.1);
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

function drawBentLimb(x1, y1, x2, y2, x3, y3) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.stroke();
}

function drawLimb(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

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

/** 绘制足球。 */
function drawBall(ball, width, height, time = performance.now()) {
  const point = toCanvas(ball, width, height);
  const air = activeBallAirHeight(ball, time);
  const lift = (10 + 30 * point.scale) * air;
  const ballY = point.y - lift;
  const radius = (5.2 + air * 4.4) * point.scale;
  const shadowScale = 1 - air * 0.58;
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${0.34 - air * 0.16})`;
  ctx.beginPath();
  ctx.ellipse(point.x, point.y + radius * 0.32, radius * 1.22 * shadowScale, radius * 0.38 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();
  if (air > 0.08) {
    ctx.strokeStyle = `rgba(248,245,233,${0.12 + air * 0.24})`;
    ctx.lineWidth = Math.max(1, 1.5 * point.scale);
    ctx.setLineDash([3 * point.scale, 4 * point.scale]);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, ballY + radius * 0.72);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.shadowColor = `rgba(248,245,233,${0.55 + air * 0.28})`;
  ctx.shadowBlur = 8 + air * 14;
  ctx.beginPath();
  ctx.fillStyle = "#f8f5e9";
  ctx.arc(point.x, ballY, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = "#111";
  ctx.arc(point.x + radius * 0.25, ballY - radius * 0.25, radius * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 返回当前真实足球在活跃球路上的视觉离地高度。 */
function activeBallAirHeight(ball, time = performance.now()) {
  if (!ball) return 0;
  if (ball.inFlight && Number.isFinite(ball.flightHeight) && Number.isFinite(ball.flightStartX) && Number.isFinite(ball.flightEndX)) {
    const start = { x: ball.flightStartX, y: ball.flightStartY };
    const end = { x: ball.flightEndX, y: ball.flightEndY };
    const progress = clampView(trajectoryProgress(ball, start, end), 0, 1);
    const arc = Math.sin(Math.PI * progress);
    return clampView(Number(ball.flightHeight || 0) * arc, 0, 1);
  }
  let air = 0;
  for (const effect of visualEffects) {
    const trajectory = effect.trajectory;
    const baseHeight = Number(trajectory?.height || 0);
    if (baseHeight < 0.45 || !trajectory?.start || !trajectory?.end) continue;
    const age = clampView((time - effect.startedAt) / VISUAL_EFFECT_MS, 0, 1);
    const progress = trajectoryProgress(ball, trajectory.start, trajectory.end);
    const laneGap = distanceToSegment(ball, trajectory.start, trajectory.end);
    if (progress < 0 || progress > 1 || laneGap > 5.5) continue;
    const timeFade = Math.sin(Math.PI * age);
    const flightArc = Math.sin(Math.PI * progress);
    air = Math.max(air, baseHeight * timeFade * flightArc);
  }
  return clampView(air, 0, 1);
}

/** 从百分比坐标转换为 Canvas 坐标。 */
function toCanvas(point, width, height) {
  const depth = clampView((point?.y ?? 50) / 100, 0, 1);
  const topY = height * 0.13;
  const bottomY = height * 0.86;
  const left = lerp(width * 0.16, width * 0.07, depth);
  const right = lerp(width * 0.84, width * 0.93, depth);
  const x = left + ((point?.x ?? 50) / 100) * (right - left);
  const y = lerp(topY, bottomY, depth);
  return { x, y, depth, scale: lerp(0.72, 1.18, depth) };
}

/** 复制绘制状态，避免插值时修改服务端快照。 */

export function cloneDrawState(state) {
  return { ...state, teams: { home: { ...state.teams.home, players: state.teams.home.players.map((player) => ({ ...player })) }, away: { ...state.teams.away, players: state.teams.away.players.map((player) => ({ ...player })) } }, ball: state.ball ? { ...state.ball } : null };
}

function projectedPolygon(points, width, height, fill = false, stroke = true) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const projected = toCanvas(point, width, height);
    if (index === 0) ctx.moveTo(projected.x, projected.y);
    else ctx.lineTo(projected.x, projected.y);
  });
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function projectedLine(x1, y1, x2, y2, width, height) {
  const start = toCanvas({ x: x1, y: y1 }, width, height);
  const end = toCanvas({ x: x2, y: y2 }, width, height);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

function projectedBox(x, y, w, h, width, height) {
  projectedPolygon([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], width, height, false, true);
}

function projectedCircle(x, y, rx, ry, width, height) {
  ctx.beginPath();
  for (let index = 0; index <= 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2;
    const point = toCanvas({ x: x + Math.cos(angle) * rx, y: y + Math.sin(angle) * ry }, width, height);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

function projectedDot(x, y, width, height) {
  const point = toCanvas({ x, y }, width, height);
  ctx.beginPath();
  ctx.arc(point.x, point.y, 3.2 * point.scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(246,255,245,.74)";
  ctx.fill();
}

function trajectoryProgress(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return 0;
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
}

function distanceToSegment(point, start, end) {
  const progress = clampView(trajectoryProgress(point, start, end), 0, 1);
  const x = lerp(start.x, end.x, progress);
  const y = lerp(start.y, end.y, progress);
  return Math.hypot((point.x ?? 0) - x, (point.y ?? 0) - y);
}

function drawGoal(x, y, side, width = canvas.width, height = canvas.height) {
  const backX = x + side * 5.2;
  const top = y - 11;
  const bottom = y + 11;
  const frontTop = toCanvas({ x, y: top }, width, height);
  const frontBottom = toCanvas({ x, y: bottom }, width, height);
  const backTop = toCanvas({ x: backX, y: top }, width, height);
  const backBottom = toCanvas({ x: backX, y: bottom }, width, height);
  const postScale = (frontTop.scale + frontBottom.scale + backTop.scale + backBottom.scale) / 4;
  const goalHeight = 24 * postScale;
  const raised = (point) => ({ x: point.x, y: point.y - goalHeight });
  const frontTopHigh = raised(frontTop);
  const frontBottomHigh = raised(frontBottom);
  const backTopHigh = raised(backTop);
  const backBottomHigh = raised(backBottom);
  ctx.save();
  drawGoalNetPanel([frontTop, frontBottom, backBottom, backTop], "rgba(244,208,111,.08)", "rgba(244,255,239,.18)");
  drawGoalNetPanel([frontTopHigh, frontBottomHigh, backBottomHigh, backTopHigh], "rgba(244,208,111,.12)", "rgba(244,255,239,.2)");
  drawGoalNetPanel([frontTop, frontTopHigh, backTopHigh, backTop], "rgba(244,255,239,.07)", "rgba(244,255,239,.2)");
  drawGoalNetPanel([frontBottom, frontBottomHigh, backBottomHigh, backBottom], "rgba(244,255,239,.07)", "rgba(244,255,239,.2)");
  drawGoalNetPanel([backTop, backTopHigh, backBottomHigh, backBottom], "rgba(244,255,239,.05)", "rgba(244,255,239,.18)");

  ctx.strokeStyle = "rgba(244,255,239,.28)";
  ctx.lineWidth = Math.max(1, 1.15 * postScale);
  for (let index = 1; index < 4; index += 1) {
    const amount = index / 4;
    drawGoalFrameLine(lerpPoint(frontTop, backTop, amount), lerpPoint(frontBottom, backBottom, amount));
    drawGoalFrameLine(lerpPoint(frontTopHigh, backTopHigh, amount), lerpPoint(frontBottomHigh, backBottomHigh, amount));
  }
  for (let index = 1; index < 3; index += 1) {
    const amount = index / 3;
    drawGoalFrameLine(lerpPoint(frontTop, frontBottom, amount), lerpPoint(backTop, backBottom, amount));
    drawGoalFrameLine(lerpPoint(frontTopHigh, frontBottomHigh, amount), lerpPoint(backTopHigh, backBottomHigh, amount));
  }

  ctx.strokeStyle = "rgba(248,252,239,.96)";
  ctx.lineWidth = Math.max(2.2, 3.2 * postScale);
  ctx.lineCap = "round";
  drawGoalFrameLine(frontTop, frontTopHigh);
  drawGoalFrameLine(frontBottom, frontBottomHigh);
  drawGoalFrameLine(frontTopHigh, frontBottomHigh);
  drawGoalFrameLine(backTop, backTopHigh);
  drawGoalFrameLine(backBottom, backBottomHigh);
  drawGoalFrameLine(backTopHigh, backBottomHigh);
  drawGoalFrameLine(frontTopHigh, backTopHigh);
  drawGoalFrameLine(frontBottomHigh, backBottomHigh);
  ctx.restore();
}

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
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawGoalFrameLine(start, end) {
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

function lerpPoint(start, end, amount) {
  return { x: lerp(start.x, end.x, amount), y: lerp(start.y, end.y, amount) };
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function clampView(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function mockState() {
  const make = (side, mirror) => ({ players: Array.from({ length: 11 }, (_, index) => ({ id: index + 1, shirt: index + 1, x: mirror ? 100 - [7,21,24,24,21,40,42,40,61,64,61][index] : [7,21,24,24,21,40,42,40,61,64,61][index], y: [50,22,40,60,78,34,50,66,24,50,76][index] })), tactics: { intent: side === "home" ? "high_press" : "compact_block" } });
  return { ball: { x: 50, y: 50 }, teams: { home: make("home", false), away: make("away", true) } };
}
