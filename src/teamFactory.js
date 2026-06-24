import { clamp, randomNormal } from "./utils.js";

const FORMATION_SLOTS = {
  "4-4-1": [[7, 50], [21, 22], [24, 40], [24, 60], [21, 78], [42, 22], [42, 40], [42, 60], [42, 78], [63, 50]],
  "4-4-2": [[7, 50], [21, 22], [24, 40], [24, 60], [21, 78], [42, 22], [42, 40], [42, 60], [42, 78], [62, 40], [62, 60]],
  "4-3-3": [[7, 50], [22, 24], [18, 41], [19, 59], [22, 76], [36, 50], [47, 37], [45, 63], [63, 26], [70, 50], [63, 74]],
  "4-2-3-1": [[7, 50], [22, 24], [18, 41], [19, 59], [22, 76], [37, 45], [39, 56], [55, 29], [58, 50], [55, 71], [69, 50]],
  "3-5-2": [[7, 50], [23, 30], [25, 50], [23, 70], [42, 14], [40, 36], [42, 50], [40, 64], [42, 86], [64, 42], [64, 58]],
  "3-4-3": [[7, 50], [23, 30], [25, 50], [23, 70], [42, 20], [40, 42], [40, 58], [42, 80], [62, 24], [66, 50], [62, 76]],
  "5-3-2": [[7, 50], [20, 15], [22, 32], [24, 50], [22, 68], [20, 85], [42, 35], [43, 50], [42, 65], [63, 42], [63, 58]],
  "4-1-4-1": [[7, 50], [21, 22], [24, 40], [24, 60], [21, 78], [35, 50], [48, 22], [46, 40], [46, 60], [48, 78], [68, 50]],
  "4-3-1-2": [[7, 50], [21, 22], [24, 40], [24, 60], [21, 78], [40, 33], [42, 50], [40, 67], [56, 50], [66, 42], [66, 58]]
};

const FORMATION_ROLE_ORDERS = {
  "4-4-1": ["GK", "RB", "CB", "CB", "LB", "RW", "CM", "AM", "LW", "ST"],
  "4-4-2": ["GK", "RB", "CB", "CB", "LB", "RW", "CM", "AM", "LW", "ST", "LW"],
  "4-3-3": ["GK", "RB", "CB", "CB", "LB", "DM", "CM", "AM", "RW", "ST", "LW"],
  "4-2-3-1": ["GK", "RB", "CB", "CB", "LB", "DM", "CM", "RW", "AM", "LW", "ST"],
  "3-5-2": ["GK", "CB", "CB", "CB", "RB", "DM", "CM", "AM", "LB", "ST", "LW"],
  "3-4-3": ["GK", "CB", "CB", "CB", "RB", "DM", "CM", "LB", "RW", "ST", "LW"],
  "5-3-2": ["GK", "RB", "CB", "CB", "CB", "LB", "DM", "CM", "AM", "ST", "LW"],
  "4-1-4-1": ["GK", "RB", "CB", "CB", "LB", "DM", "RW", "CM", "AM", "LW", "ST"],
  "4-3-1-2": ["GK", "RB", "CB", "CB", "LB", "DM", "CM", "AM", "RW", "ST", "LW"]
};

const ROLE_FALLBACKS = {
  GK: ["GK"],
  CB: ["CB", "DM", "RB", "LB"],
  RB: ["RB", "CB", "RW"],
  LB: ["LB", "CB", "LW"],
  DM: ["DM", "CM", "CB"],
  CM: ["CM", "DM", "AM"],
  AM: ["AM", "CM", "ST", "RW", "LW"],
  RW: ["RW", "AM", "RB", "CM", "LW"],
  LW: ["LW", "AM", "LB", "CM", "RW"],
  ST: ["ST", "LW", "RW", "AM", "CM"]
};

const PLAYER_TEMPLATES = [
  [1, "GK", "门将", { speed: 48, passing: 64, vision: 62, shooting: 20, defense: 52, tackle: 42, positioning: 76, strength: 70, agility: 68, goalkeeper: 88, stamina: 82, mental: 82 }],
  [2, "RB", "边后卫", { speed: 78, passing: 70, vision: 66, shooting: 45, defense: 73, tackle: 74, positioning: 72, strength: 68, agility: 76, goalkeeper: 10, stamina: 86, mental: 72 }],
  [3, "CB", "中后卫", { speed: 64, passing: 65, vision: 64, shooting: 38, defense: 84, tackle: 83, positioning: 85, strength: 86, agility: 60, goalkeeper: 10, stamina: 82, mental: 78 }],
  [4, "CB", "中后卫", { speed: 63, passing: 66, vision: 65, shooting: 39, defense: 85, tackle: 84, positioning: 84, strength: 86, agility: 60, goalkeeper: 10, stamina: 82, mental: 79 }],
  [5, "LB", "边后卫", { speed: 77, passing: 70, vision: 66, shooting: 44, defense: 73, tackle: 74, positioning: 72, strength: 68, agility: 76, goalkeeper: 10, stamina: 86, mental: 72 }],
  [6, "DM", "后腰", { speed: 68, passing: 78, vision: 76, shooting: 56, defense: 78, tackle: 80, positioning: 82, strength: 76, agility: 69, goalkeeper: 10, stamina: 88, mental: 80 }],
  [7, "CM", "中场", { speed: 72, passing: 82, vision: 82, shooting: 66, defense: 70, tackle: 72, positioning: 78, strength: 72, agility: 76, goalkeeper: 10, stamina: 90, mental: 82 }],
  [8, "AM", "前腰", { speed: 74, passing: 90, vision: 92, shooting: 76, defense: 50, tackle: 48, positioning: 80, strength: 66, agility: 84, goalkeeper: 10, stamina: 82, mental: 84 }],
  [9, "RW", "边锋", { speed: 86, passing: 74, vision: 72, shooting: 76, defense: 48, tackle: 45, positioning: 70, strength: 62, agility: 88, goalkeeper: 10, stamina: 84, mental: 73 }],
  [10, "ST", "前锋", { speed: 80, passing: 68, vision: 72, shooting: 88, defense: 38, tackle: 36, positioning: 84, strength: 78, agility: 78, goalkeeper: 10, stamina: 80, mental: 82 }],
  [11, "LW", "边锋", { speed: 85, passing: 74, vision: 72, shooting: 75, defense: 48, tackle: 44, positioning: 70, strength: 62, agility: 88, goalkeeper: 10, stamina: 84, mental: 73 }]
];

/** 创建镜像球队。 */
export function createMirrorTeams(config = {}, rng) {
  const forms = PLAYER_TEMPLATES.map(([, , , attributes]) => clamp(Math.round(randomNormal(rng, 0, 2) + ((attributes.mental - 50) / 50) * 1.5), -5, 5));
  const homeFormation = config.match?.homeFormation || config.homeFormation || "4-3-3";
  const awayFormation = config.match?.awayFormation || config.awayFormation || "4-2-3-1";
  return {
    home: createTeam("home", config.homeCoach?.name || "主队", homeFormation, forms, false),
    away: createTeam("away", config.awayCoach?.name || "客队", awayFormation, forms, true)
  };
}

/** 创建单支球队。 */
export function createTeam(id, name, formation, forms, mirror) {
  const players = [];
  for (let index = 0; index < 23; index += 1) {
    const base = PLAYER_TEMPLATES[index % PLAYER_TEMPLATES.length];
    const [shirt, position, role, attributes] = base;
    const playerId = index + 1;
    players.push({
      id: playerId,
      shirt: playerId <= 11 ? shirt : playerId,
      name: `${id === "home" ? "主" : "客"}${playerId}号`,
      position,
      role,
      attributes: { ...attributes },
      hidden: { foul_tendency: 0.35 + (playerId % 5) * 0.05, directness: 0.4 + (playerId % 4) * 0.08 },
      staminaMax: attributes.stamina,
      stamina: attributes.stamina,
      form: forms[index % forms.length],
      formationSlot: index % PLAYER_TEMPLATES.length,
      onField: playerId <= 11,
      sentOff: false,
      yellowCards: 0,
      x: 50,
      y: 50,
      targetX: 50,
      targetY: 50,
      lastAction: "站位"
    });
  }
  applyFormation(players, formation, mirror);
  return {
    id,
    name,
    formation,
    score: 0,
    players,
    tactics: defaultTactics(formation),
    substitutions: { used: 0, windowsUsed: 0, extraGranted: false, usedPlayers: [], lastWindowTick: null },
    stats: { shots: 0, shotsOnTarget: 0, xG: 0, possessionTicks: 0, passes: 0, completedPasses: 0, tackles: 0, fouls: 0, yellowCards: 0, redCards: 0, offsides: 0, corners: 0, interceptions: 0, counterAttacks: 0, boxEntries: 0 }
  };
}

/** 应用阵型目标站位，比赛进行中的调整必须保留当前坐标。 */
export function applyFormation(players, formation, mirror = false, options = {}) {
  const slots = FORMATION_SLOTS[formation] || FORMATION_SLOTS["4-3-3"];
  const resetPositions = options.resetPositions ?? true;
  orderPlayersForFormation(players, formation).forEach((player, index) => {
    const slot = slots[index] || [50, 50];
    player.baseTargetX = mirror ? 100 - slot[0] : slot[0];
    player.baseTargetY = slot[1];
    player.targetX = player.baseTargetX;
    player.targetY = player.baseTargetY;
    if (resetPositions) {
      player.x = player.targetX;
      player.y = player.targetY;
    }
  });
}

/** 按阵型职责顺序分配场上球员，避免边锋被套进中锋槽位。 */
function orderPlayersForFormation(players, formation) {
  const remaining = players
    .filter((player) => player.onField && !player.sentOff)
    .sort((left, right) => (left.formationSlot ?? left.id) - (right.formationSlot ?? right.id));
  const roleOrder = FORMATION_ROLE_ORDERS[formation] || FORMATION_ROLE_ORDERS["4-3-3"];
  const ordered = [];
  for (const role of roleOrder) {
    if (!remaining.length) break;
    const index = bestRoleMatchIndex(remaining, role);
    ordered.push(...remaining.splice(index, 1));
  }
  return [...ordered, ...remaining];
}

/** 返回最适合指定阵型职责的球员索引。 */
function bestRoleMatchIndex(players, role) {
  const candidates = ROLE_FALLBACKS[role] || [role];
  for (const candidate of candidates) {
    const index = players.findIndex((player) => player.position === candidate);
    if (index !== -1) return index;
  }
  return 0;
}

/** 返回默认球队战术。 */
export function defaultTactics(formation = "4-3-3") {
  return {
    formation,
    intent: "control_possession",
    riskLevel: 0.5,
    tempo: "balanced",
    pressingHeight: "medium",
    pressingIntensity: "medium",
    defensiveLine: "medium",
    attackingWidth: "balanced",
    defensiveWidth: "balanced",
    passingRisk: "medium",
    transition: "hold_shape",
    focusChannel: "mixed",
    appliedTick: 0
  };
}

/** 获取场上球员。 */
export function getOnFieldPlayers(team) {
  return team.players.filter((player) => player.onField && !player.sentOff);
}

export const SUPPORTED_FORMATIONS = Object.keys(FORMATION_SLOTS);
