import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { clone, DEFAULT_MATCH_MINUTES, normalizeMatchMinutes, redactSensitive, safeJson } from "./utils.js";

export const ROOT_DIR = process.cwd();
export const FALLBACK_RUNTIME_ROOT = path.join(ROOT_DIR, "cache", "runtime");
export const DIRS = {
  config: path.join(ROOT_DIR, "config"),
  matches: path.join(ROOT_DIR, "matches"),
  reports: path.join(ROOT_DIR, "reports"),
  cache: path.join(ROOT_DIR, "cache")
};

export const CONFIG_PATH = path.join(DIRS.config, "app.json");

export async function ensureRuntimeDirs() {
  const dirs = runtimeDirs();
  await Promise.all([DIRS.config, dirs.matches, dirs.reports, DIRS.cache].map((directory) => mkdir(directory, { recursive: true })));
}

export function defaultConfig() {
  return {
    homeCoach: { provider: "local", name: "主队", model: "rules-coach", endpoint: "", api_key_ref: "", api_key_set: false, free_strategy_prompt: "" },
    awayCoach: { provider: "local", name: "客队", model: "rules-coach", endpoint: "", api_key_ref: "", api_key_set: false, free_strategy_prompt: "" },
    match: { seed: "20260620", knockout: false, homeFormation: "", awayFormation: "", matchMinutes: DEFAULT_MATCH_MINUTES, goalPaceMultiplier: 1, allowHalfTimeAdjustments: true, autoSubstitution: true }
  };
}

export async function loadConfig() {
  await ensureRuntimeDirs();
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    return mergeConfig(JSON.parse(text));
  } catch {
    return defaultConfig();
  }
}

export async function saveConfig(config) {
  await ensureRuntimeDirs();
  const merged = mergeConfig(config);
  for (const side of ["homeCoach", "awayCoach"]) {
    if (merged[side]?.api_key_once && !merged[side]?.api_key) merged[side].api_key = merged[side].api_key_once;
    const apiKeySet = Boolean(merged[side]?.api_key || merged[side]?.api_key_ref);
    delete merged[side].api_key_once;
    merged[side].api_key_set = apiKeySet;
  }
  await writeFile(CONFIG_PATH, safeJson(merged), "utf8");
  return merged;
}

export function sanitizeConfig(config, extraSecrets = []) {
  const safe = redactSensitive(clone(config), extraSecrets);
  for (const side of ["homeCoach", "awayCoach"]) {
    if (!safe[side]) continue;
    delete safe[side].api_key;
    delete safe[side].api_key_once;
    safe[side].api_key_set = Boolean(config[side]?.api_key || config[side]?.api_key_ref || config[side]?.api_key_once);
  }
  return safe;
}

export async function writeJson(filePath, value, extraSecrets = []) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, safeJson(redactSensitive(value, extraSecrets)), "utf8");
}

export async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

export function mergeConfig(input = {}) {
  const base = defaultConfig();
  const match = { ...base.match, ...(input.match || {}) };
  match.homeFormation = String(match.homeFormation || "").trim();
  match.awayFormation = String(match.awayFormation || "").trim();
  match.matchMinutes = normalizeMatchMinutes(match.matchMinutes);
  match.goalPaceMultiplier = Number.isFinite(match.goalPaceMultiplier) && match.goalPaceMultiplier > 0 ? match.goalPaceMultiplier : 1;
  return {
    homeCoach: normalizeCoachConfig({ ...base.homeCoach, ...(input.homeCoach || {}) }),
    awayCoach: normalizeCoachConfig({ ...base.awayCoach, ...(input.awayCoach || {}) }),
    match
  };
}

export function matchPaths(matchId) {
  const primary = matchPathsForRoot(matchId, runtimeRoot());
  if (process.env.FOOTBALL_RUNTIME_DIR) return primary;
  const fallback = matchPathsForRoot(matchId, FALLBACK_RUNTIME_ROOT);
  return pathExistsSync(fallback.matchDir) || pathExistsSync(fallback.reportDir) ? fallback : primary;
}

export function fallbackMatchPaths(matchId) {
  return matchPathsForRoot(matchId, FALLBACK_RUNTIME_ROOT);
}

function normalizeCoachConfig(coach) {
  return { ...coach, free_strategy_prompt: String(coach.free_strategy_prompt || "").trim() };
}

function runtimeRoot() {
  return process.env.FOOTBALL_RUNTIME_DIR ? path.resolve(process.env.FOOTBALL_RUNTIME_DIR) : ROOT_DIR;
}

function runtimeDirs() {
  const root = runtimeRoot();
  return {
    matches: path.join(root, "matches"),
    reports: path.join(root, "reports")
  };
}

function matchPathsForRoot(matchId, root) {
  return {
    matchDir: path.join(root, "matches", matchId),
    rawOutputDir: path.join(root, "matches", matchId, "raw_outputs"),
    matchLog: path.join(root, "matches", matchId, "match_log.json"),
    reportDir: path.join(root, "reports", matchId),
    summary: path.join(root, "reports", matchId, "summary.md"),
    report: path.join(root, "reports", matchId, "report.md")
  };
}

function pathExistsSync(filePath) {
  return existsSync(filePath);
}
