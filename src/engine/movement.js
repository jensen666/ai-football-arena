import { getOnFieldPlayers } from "../teamFactory.js";
import { TICKS_PER_SECOND, clamp, distance } from "../utils.js";

const SUPPORT_MIN_GAP = 4.2;
const PRESS_MIN_GAP = 3.6;
const TEAM_TARGET_MIN_GAP = 2.45;
const CENTRAL_TARGET_MIN_GAP = 3.05;
const GK_TARGET_MIN_GAP = 3.35;

export function installMovementMethods(MatchEngine) {
  Object.assign(MatchEngine.prototype, {
  updatePlayers,
  updateDynamicTargets,
  supportDepthMargin,
  supportLaneDirection,
  pressLaneOffset,
  defensiveDangerTarget,
  defensiveRoleMobility,
  staminaTickCost,
  centralCoverCandidate,
  applyCentralCompactness,
  separateTargetFromPoint,
  teamTargetMinGap,
  playerTargetBounds,
  clampPlayerTarget,
  targetLaneDirection,
  targetDepthDirection,
  targetMoveWeights,
  separateTeamTargets,
  clampPlayerPosition,
  separateTeamPositions
  });
}

function updatePlayers() {
  for (const side of ["home", "away"]) {
    const players = getOnFieldPlayers(this.teams[side]);
    for (const player of players) {
      const dx = player.targetX - player.x;
      const dy = player.targetY - player.y;
      const gap = Math.hypot(dx, dy);
      const maxStep = player.position === "GK" ? 0.16 : 0.22 + player.attributes.speed / 700;
      const step = Math.min(gap, maxStep, Math.max(0.035, gap * 0.18));
      if (gap > 0.001) {
        player.x += (dx / gap) * step;
        player.y += (dy / gap) * step;
      }
      const cost = this.staminaTickCost(this.teams[side].tactics);
      player.stamina = clamp(player.stamina - cost, 0, player.staminaMax);
    }
    const lockedPositionIds = new Set();
    if (this.ball.holderTeam === side) lockedPositionIds.add(this.ball.holderId);
    if (this.passReception?.teamId === side) lockedPositionIds.add(this.passReception.receiverId);
    this.separateTeamPositions(side, players, lockedPositionIds);
  }
  const holder = this.teams[this.possessionTeam].players.find((player) => player.id === this.ball.holderId);
  const targetX = Number.isFinite(this.ball.targetX) ? this.ball.targetX : holder?.x;
  const targetY = Number.isFinite(this.ball.targetY) ? this.ball.targetY : holder?.y;
  if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
    const dx = targetX - this.ball.x;
    const dy = targetY - this.ball.y;
    const gap = Math.hypot(dx, dy);
    const step = Math.min(gap, 0.55 + gap * 0.004);
    if (gap > 0.001) {
      const moveX = (dx / gap) * step;
      const moveY = (dy / gap) * step;
      this.ball.x += moveX;
      this.ball.y += moveY;
      this.ball.vx = moveX;
      this.ball.vy = moveY;
    } else {
      this.ball.vx = 0;
      this.ball.vy = 0;
    }
    this.completePassReceptionIfReady();
  }
}

/** 根据球权、球位和节奏更新动态跑位目标。 */
function updateDynamicTargets() {
  const holderTeam = this.teams[this.possessionTeam];
  const holder = holderTeam.players.find((player) => player.id === this.ball.holderId);
  const receptionPoint = this.passReception ? { x: this.passReception.targetX, y: this.passReception.targetY } : null;
  const pressurePoint = receptionPoint || (holder && this.isBallWithPlayer(holder, 7) ? holder : { x: Number.isFinite(this.ball.targetX) ? this.ball.targetX : this.ball.x, y: Number.isFinite(this.ball.targetY) ? this.ball.targetY : this.ball.y });
  for (const side of ["home", "away"]) {
    const team = this.teams[side];
    const direction = side === "home" ? 1 : -1;
    const hasBall = side === this.possessionTeam;
    const players = getOnFieldPlayers(team);
    const pressShift = team.tactics.pressingHeight === "high" ? 8 : team.tactics.pressingHeight === "low" ? -6 : 0;
    const defensiveLineShift = team.tactics.defensiveLine === "high" ? 5 : team.tactics.defensiveLine === "low" ? -5 : 0;
    const attackWidthShift = team.tactics.attackingWidth === "wide" ? 6 : team.tactics.attackingWidth === "narrow" ? -4 : 0;
    const defensiveWidthBias = team.tactics.defensiveWidth === "wide" ? 0.18 : team.tactics.defensiveWidth === "narrow" ? 0.34 : 0.26;
    const defensiveCenterBias = team.tactics.defensiveWidth === "wide" ? -0.03 : team.tactics.defensiveWidth === "narrow" ? 0.1 : 0.04;
    const defensiveBallBias = team.tactics.pressingIntensity === "high" ? 0.3 : team.tactics.pressingIntensity === "low" ? 0.16 : 0.23;
    const pressureStrength = team.tactics.pressingIntensity === "high" ? 0.76 : team.tactics.pressingIntensity === "low" ? 0.46 : 0.62;
    const secondLastLine = hasBall ? this.secondLastDefenderLine(side) : null;
    const threatDepth = side === "home" ? 100 - pressurePoint.x : pressurePoint.x;
    const defensiveDanger = !hasBall && threatDepth >= 74;
    const pressers = hasBall
      ? []
      : players
          .filter((player) => player.position !== "GK")
          .map((player) => ({ player, gap: distance(player, pressurePoint) }))
          .sort((left, right) => left.gap - right.gap)
          .slice(0, 2)
          .map((item) => item.player.id);
    const lockedTargetIds = new Set();
    if (this.passReception?.teamId === side) lockedTargetIds.add(this.passReception.receiverId);
    if (hasBall && Number.isFinite(this.ball.targetX) && Number.isFinite(this.ball.targetY)) lockedTargetIds.add(this.ball.holderId);
    for (const player of players) {
      const baseX = player.baseTargetX ?? player.targetX;
      const baseY = player.baseTargetY ?? player.targetY;
      const phase = (this.tick + player.id * 19 + (side === "away" ? 11 : 0)) / 38;
      if (this.passReception && side === this.passReception.teamId && player.id === this.passReception.receiverId) {
        const receptionTarget = this.receptionRunnerTarget(player);
        player.targetX = clamp(receptionTarget.x, 4, 96);
        player.targetY = clamp(receptionTarget.y, 4, 96);
        continue;
      }
      if (player.position === "GK") {
        const [minX, maxX] = side === "home" ? [5, 16] : [84, 95];
        const targetX = !this.passReception && Number.isFinite(this.ball.targetX) && hasBall && player.id === this.ball.holderId ? this.ball.targetX : baseX + (this.ball.x - baseX) * 0.025 + Math.cos(phase) * 0.35;
        const targetY = !this.passReception && Number.isFinite(this.ball.targetY) && hasBall && player.id === this.ball.holderId ? this.ball.targetY : 50 + (this.ball.y - 50) * 0.16 + Math.sin(phase) * 0.45;
        player.targetX = clamp(targetX, minX, maxX);
        player.targetY = clamp(targetY, 34, 66);
        continue;
      }
      if (!this.passReception && hasBall && player.id === this.ball.holderId && Number.isFinite(this.ball.targetX) && Number.isFinite(this.ball.targetY)) {
        player.targetX = clamp(this.ball.targetX, 4, 96);
        player.targetY = clamp(this.ball.targetY, 4, 96);
        continue;
      }
      const roleDepth = { CB: 0, RB: 2, LB: 2, DM: 4, CM: 6, AM: 10, RW: 12, LW: 12, ST: 14 }[player.position] ?? 4;
      const roleWidth = ["RW", "LW"].includes(player.position) ? 3.4 : ["RB", "LB"].includes(player.position) ? 2.4 : 1.6;
      if (hasBall) {
        const supportX = (5 + roleDepth) * direction;
        const laneY = baseY < 50 ? -attackWidthShift : baseY > 50 ? attackWidthShift : 0;
        const weaveX = Math.cos(phase) * 1.8;
        const weaveY = Math.sin(phase * 1.35) * roleWidth;
        let targetX = this.onsideSupportTargetX(side, baseX + pressShift * direction + supportX + (this.ball.x - baseX) * 0.08 + weaveX, this.ball.x, secondLastLine, this.supportDepthMargin(player));
        let targetY = baseY + laneY + (this.ball.y - baseY) * 0.08 + weaveY;
        if (holder && player.id !== holder.id) {
          ({ x: targetX, y: targetY } = this.separateTargetFromPoint(targetX, targetY, holder, SUPPORT_MIN_GAP, this.supportLaneDirection(player, holder.y)));
        }
        player.targetX = clamp(targetX, 4, 96);
        player.targetY = clamp(targetY, 4, 96);
        continue;
      }
      const defensiveMobility = this.defensiveRoleMobility(player);
      let targetX = baseX + (pressShift + defensiveLineShift) * direction * defensiveMobility.shapeShift + (pressurePoint.x - baseX) * defensiveBallBias * defensiveMobility.ballShift + Math.cos(phase) * 0.7;
      let targetY = baseY + (pressurePoint.y - baseY) * defensiveWidthBias + (50 - baseY) * defensiveCenterBias + Math.sin(phase * 1.35) * roleWidth * 0.45;
      const presserIndex = pressers.indexOf(player.id);
      if (presserIndex !== -1) {
        const tightGap = team.tactics.pressingIntensity === "high" ? 3.6 : team.tactics.pressingIntensity === "low" ? 6.4 : 4.8;
        const coverGap = team.tactics.pressingIntensity === "high" ? 6.8 : team.tactics.pressingIntensity === "low" ? 10 : 8.4;
        const pressureGap = presserIndex === 0 ? tightGap : coverGap;
        const channelOffset = presserIndex === 0 ? this.pressLaneOffset(player, pressurePoint) : baseY < pressurePoint.y ? -4 : 4;
        const heightBoost = team.tactics.pressingHeight === "high" ? 0.06 : team.tactics.pressingHeight === "low" ? -0.08 : 0;
        const pressureWeight = clamp(pressureStrength - presserIndex * 0.18 + heightBoost, 0.35, 0.82);
        const pressureX = pressurePoint.x - direction * pressureGap;
        const pressureY = pressurePoint.y + channelOffset;
        targetX = targetX * (1 - pressureWeight) + pressureX * pressureWeight;
        targetY = targetY * (1 - pressureWeight) + pressureY * pressureWeight;
        ({ x: targetX, y: targetY } = this.separateTargetFromPoint(targetX, targetY, pressurePoint, PRESS_MIN_GAP, channelOffset || this.pressLaneOffset(player, pressurePoint)));
      }
      if (defensiveDanger && presserIndex === -1) {
        const danger = this.defensiveDangerTarget(side, player, pressurePoint);
        const dangerWeight = ["CB", "RB", "LB", "DM", "CM"].includes(player.position) ? 0.72 : 0.48;
        targetX = targetX * (1 - dangerWeight) + danger.x * dangerWeight;
        targetY = targetY * (1 - dangerWeight) + danger.y * dangerWeight;
      }
      player.targetX = clamp(targetX, 4, 96);
      player.targetY = clamp(targetY, 4, 96);
    }
    this.applyCentralCompactness(side, players, hasBall, pressurePoint, lockedTargetIds, pressers);
    this.separateTeamTargets(side, players, lockedTargetIds);
  }
}

/** 返回不同职责相对越位线的接应纵深。 */
function supportDepthMargin(player) {
  return ({ ST: 3.2, RW: 6.5, LW: 6.5, AM: 7.2, CM: 9, DM: 12, RB: 14, LB: 14, CB: 16 }[player.position] ?? 8);
}

/** 根据职责和基础通道返回接应的横向分离方向。 */
function supportLaneDirection(player, anchorY) {
  const baseY = player.baseTargetY ?? player.y;
  if (Math.abs(baseY - anchorY) > 1) return Math.sign(baseY - anchorY);
  return player.id % 2 === 0 ? 1 : -1;
}

/** 返回防守人侧身上抢的横向偏移。 */
function pressLaneOffset(player, pressurePoint) {
  return this.supportLaneDirection(player, pressurePoint.y) * 2.8;
}

function defensiveDangerTarget(side, player, pressurePoint) {
  const direction = side === "home" ? 1 : -1;
  const isBackLine = ["CB", "RB", "LB"].includes(player.position);
  const gapByRole = {
    CB: 5.2,
    RB: 6.8,
    LB: 6.8,
    DM: 6.4,
    CM: 8.2,
    AM: 10.2,
    RW: 12,
    LW: 12,
    ST: 15
  };
  const gap = gapByRole[player.position] ?? 9;
  const targetX = isBackLine ? pressurePoint.x - direction * gap : pressurePoint.x + direction * gap;
  const baseY = player.baseTargetY ?? player.targetY ?? player.y;
  const laneScale = ["RB", "LB", "RW", "LW"].includes(player.position) ? 0.45 : ["CB", "DM", "CM"].includes(player.position) ? 0.22 : 0.3;
  return { x: targetX, y: pressurePoint.y + (baseY - 50) * laneScale };
}

function defensiveRoleMobility(player) {
  if (["CB", "RB", "LB"].includes(player.position)) return { shapeShift: 0.45, ballShift: 0.42 };
  if (player.position === "DM") return { shapeShift: 0.62, ballShift: 0.65 };
  if (["CM", "AM"].includes(player.position)) return { shapeShift: 0.82, ballShift: 0.82 };
  return { shapeShift: 1, ballShift: 1 };
}

function staminaTickCost(tactics = {}) {
  const heightDrain = { low: 10, medium: 16, high: 24 }[tactics.pressingHeight] ?? 16;
  const intensityDrain = { low: -2, medium: 0, high: 6 }[tactics.pressingIntensity] ?? 0;
  const tempoDrain = { slow: -1, balanced: 0, fast: 2 }[tactics.tempo] ?? 0;
  const fullMatchDrain = clamp(heightDrain + intensityDrain + tempoDrain, 8, 34);
  return fullMatchDrain / Math.max(this.fullTimeSeconds * TICKS_PER_SECOND, 1);
}

/** 保持目标纵深，沿横向通道把球员从锚点周围拉开。 */
function centralCoverCandidate(players, lockedTargetIds, pressers = []) {
  const priority = { DM: 0, CM: 1, AM: 2, RB: 3, LB: 3 };
  return players
    .filter((player) => player.onField && !player.sentOff && priority[player.position] !== undefined && !lockedTargetIds.has(player.id) && !pressers.includes(player.id))
    .sort((left, right) => priority[left.position] - priority[right.position] || Math.abs((left.baseTargetY ?? left.y) - 50) - Math.abs((right.baseTargetY ?? right.y) - 50))[0];
}

function applyCentralCompactness(side, players, hasBall, pressurePoint, lockedTargetIds, pressers = []) {
  if (!pressurePoint || !Number.isFinite(pressurePoint.x) || !Number.isFinite(pressurePoint.y)) return;
  const direction = side === "home" ? 1 : -1;
  const depth = hasBall ? (side === "home" ? pressurePoint.x : 100 - pressurePoint.x) : (side === "home" ? 100 - pressurePoint.x : pressurePoint.x);
  if (depth < 58) return;
  const cover = this.centralCoverCandidate(players, lockedTargetIds, hasBall ? [] : pressers);
  if (!cover) return;

  const centralY = 50 + (pressurePoint.y - 50) * 0.08;
  const targetX = hasBall ? pressurePoint.x - direction * (depth > 76 ? 32 : 24) : pressurePoint.x - direction * (depth > 76 ? 14 : 10);
  const minX = side === "home" ? 26 : 38;
  const maxX = side === "home" ? 62 : 74;
  const compactX = clamp(targetX, minX, maxX);
  const weight = hasBall ? 0.62 : 0.52;
  cover.targetX = cover.targetX * (1 - weight) + compactX * weight;
  cover.targetY = cover.targetY * (1 - weight) + centralY * weight;
  this.clampPlayerTarget(side, cover);
}

function separateTargetFromPoint(targetX, targetY, anchor, minGap, fallbackYDirection = 1) {
  if (!anchor || !Number.isFinite(targetX) || !Number.isFinite(targetY)) return { x: targetX, y: targetY };
  const dx = targetX - anchor.x;
  const dy = targetY - anchor.y;
  if (Math.hypot(dx, dy) >= minGap) return { x: targetX, y: targetY };
  const yDirection = Math.abs(dy) > 0.2 ? Math.sign(dy) : Math.sign(fallbackYDirection) || 1;
  const yGap = Math.sqrt(Math.max(minGap * minGap - dx * dx, minGap * minGap * 0.72));
  return { x: targetX, y: anchor.y + yDirection * yGap };
}

function teamTargetMinGap(left, right) {
  if (left.position === "GK" || right.position === "GK") return GK_TARGET_MIN_GAP;
  const centralRoles = new Set(["CB", "DM", "CM"]);
  if (centralRoles.has(left.position) && centralRoles.has(right.position)) return CENTRAL_TARGET_MIN_GAP;
  if (["RB", "LB", "CB", "DM", "CM"].includes(left.position) && ["RB", "LB", "CB", "DM", "CM"].includes(right.position)) return 2.75;
  return TEAM_TARGET_MIN_GAP;
}

function playerTargetBounds(side, player) {
  if (player.position === "GK") {
    const [minX, maxX] = side === "home" ? [5, 16] : [84, 95];
    return { minX, maxX, minY: 34, maxY: 66 };
  }
  return { minX: 4, maxX: 96, minY: 4, maxY: 96 };
}

function clampPlayerTarget(side, player) {
  const bounds = this.playerTargetBounds(side, player);
  player.targetX = clamp(player.targetX, bounds.minX, bounds.maxX);
  player.targetY = clamp(player.targetY, bounds.minY, bounds.maxY);
}

function targetLaneDirection(left, right) {
  const leftBaseY = left.baseTargetY ?? left.targetY ?? left.y;
  const rightBaseY = right.baseTargetY ?? right.targetY ?? right.y;
  if (Math.abs(leftBaseY - rightBaseY) > 0.4) return Math.sign(leftBaseY - rightBaseY);
  if (Math.abs((left.targetY ?? left.y) - (right.targetY ?? right.y)) > 0.2) return Math.sign((left.targetY ?? left.y) - (right.targetY ?? right.y));
  return left.id > right.id ? 1 : -1;
}

function targetDepthDirection(side, left, right) {
  const leftBaseX = left.baseTargetX ?? left.targetX ?? left.x;
  const rightBaseX = right.baseTargetX ?? right.targetX ?? right.x;
  if (Math.abs(leftBaseX - rightBaseX) > 0.4) return Math.sign(leftBaseX - rightBaseX);
  const attackDirection = side === "home" ? 1 : -1;
  return (left.id > right.id ? 1 : -1) * attackDirection;
}

function targetMoveWeights(left, right, lockedTargetIds) {
  const leftLocked = lockedTargetIds.has(left.id) || left.position === "GK";
  const rightLocked = lockedTargetIds.has(right.id) || right.position === "GK";
  if (leftLocked && rightLocked) return { left: 0, right: 0 };
  if (leftLocked) return { left: 0, right: 1 };
  if (rightLocked) return { left: 1, right: 0 };
  return { left: 0.5, right: 0.5 };
}

function separateTeamTargets(side, players, lockedTargetIds = new Set()) {
  const active = players.filter((player) => player.onField && !player.sentOff && Number.isFinite(player.targetX) && Number.isFinite(player.targetY));
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const left = active[i];
        const right = active[j];
        const minGap = this.teamTargetMinGap(left, right);
        let dx = left.targetX - right.targetX;
        let dy = left.targetY - right.targetY;
        let gap = Math.hypot(dx, dy);
        if (gap >= minGap) continue;
        const weights = this.targetMoveWeights(left, right, lockedTargetIds);
        if (weights.left === 0 && weights.right === 0) continue;

        const laneDirection = Math.abs(dy) > 0.2 ? Math.sign(dy) : this.targetLaneDirection(left, right);
        const needed = minGap - gap + 0.18;
        left.targetY += laneDirection * needed * weights.left;
        right.targetY -= laneDirection * needed * weights.right;
        this.clampPlayerTarget(side, left);
        this.clampPlayerTarget(side, right);

        dx = left.targetX - right.targetX;
        dy = left.targetY - right.targetY;
        gap = Math.hypot(dx, dy);
        if (gap < minGap) {
          const depthDirection = Math.abs(dx) > 0.2 ? Math.sign(dx) : this.targetDepthDirection(side, left, right);
          const depthNeeded = Math.sqrt(Math.max(minGap * minGap - dy * dy, 0)) - Math.abs(dx) + 0.16;
          if (depthNeeded > 0) {
            left.targetX += depthDirection * depthNeeded * weights.left;
            right.targetX -= depthDirection * depthNeeded * weights.right;
            this.clampPlayerTarget(side, left);
            this.clampPlayerTarget(side, right);
          }
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function clampPlayerPosition(side, player) {
  const bounds = this.playerTargetBounds(side, player);
  player.x = clamp(player.x, bounds.minX, bounds.maxX);
  player.y = clamp(player.y, bounds.minY, bounds.maxY);
}

function separateTeamPositions(side, players, lockedPositionIds = new Set()) {
  const active = players.filter((player) => player.onField && !player.sentOff && Number.isFinite(player.x) && Number.isFinite(player.y));
  const minGap = 1.18;
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const left = active[i];
        const right = active[j];
        let dx = left.x - right.x;
        let dy = left.y - right.y;
        let gap = Math.hypot(dx, dy);
        if (gap >= minGap) continue;
        const weights = this.targetMoveWeights(left, right, lockedPositionIds);
        if (weights.left === 0 && weights.right === 0) continue;

        const laneDirection = Math.abs(dy) > 0.08 ? Math.sign(dy) : this.targetLaneDirection(left, right);
        const needed = minGap - gap + 0.06;
        left.y += laneDirection * needed * weights.left;
        right.y -= laneDirection * needed * weights.right;
        this.clampPlayerPosition(side, left);
        this.clampPlayerPosition(side, right);

        dx = left.x - right.x;
        dy = left.y - right.y;
        gap = Math.hypot(dx, dy);
        if (gap < minGap) {
          const depthDirection = Math.abs(dx) > 0.08 ? Math.sign(dx) : this.targetDepthDirection(side, left, right);
          const depthNeeded = Math.sqrt(Math.max(minGap * minGap - dy * dy, 0)) - Math.abs(dx) + 0.04;
          if (depthNeeded > 0) {
            left.x += depthDirection * depthNeeded * weights.left;
            right.x -= depthDirection * depthNeeded * weights.right;
            this.clampPlayerPosition(side, left);
            this.clampPlayerPosition(side, right);
          }
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
}
