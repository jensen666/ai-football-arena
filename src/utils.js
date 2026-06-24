export const TICKS_PER_SECOND = 30;
export const DEFAULT_MATCH_MINUTES = 90;
export const MIN_MATCH_MINUTES = 1;
export const MAX_MATCH_MINUTES = 90;
export const FULL_TIME_SECONDS = DEFAULT_MATCH_MINUTES * 60;
export const HALF_SECONDS = FULL_TIME_SECONDS / 2;
export const EXTRA_TIME_SECONDS = 30 * 60;

const TOKEN_STAT_KEYS = new Set(["inputTokens", "outputTokens", "totalTokens", "lastTokens", "input_tokens", "output_tokens", "total_tokens", "last_tokens"]);
const SAFE_SECRET_STATUS_KEYS = new Set(["api_key_set"]);

/** 将数值限制在指定范围。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/** 规范化本地演示比赛时长分钟数。 */
export function normalizeMatchMinutes(value, fallback = DEFAULT_MATCH_MINUTES) {
  const number = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  if (!Number.isInteger(number) || number < MIN_MATCH_MINUTES || number > MAX_MATCH_MINUTES) return fallback;
  return number;
}

/** 创建可复现的 Mulberry32 随机数生成器。 */
export function createRng(seedInput = Date.now().toString()) {
  let seed = 0x811c9dc5;
  const text = String(seedInput || Date.now());
  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  return {
    seed: text,
    next() {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let value = seed;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    }
  };
}

/** 生成确定性正态近似随机数。 */
export function randomNormal(rng, mean = 0, std = 1) {
  const u1 = Math.max(rng.next(), 1e-9);
  const u2 = Math.max(rng.next(), 1e-9);
  return mean + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;
}

/** 计算两点距离。 */
export function distance(a, b) {
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0));
}

/** 将比赛秒数格式化为显示时间。 */
export function formatGameTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const minute = Math.floor(whole / 60);
  const second = whole % 60;
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/** 返回 ISO 时间字符串。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 生成本地 match id。 */
export function createId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 深拷贝 JSON 兼容对象。 */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 递归脱敏对象中的密钥和本机敏感路径。 */
export function redactSensitive(value, extraSecrets = []) {
  const secrets = extraSecrets.filter(Boolean).map(String);
  const redactText = (text) => {
    let output = String(text);
    for (const secret of secrets) output = output.split(secret).join("[已脱敏]");
    output = output.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[已脱敏]");
    output = output.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已脱敏]");
    output = output.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g, "[本机路径已脱敏]");
    return output;
  };
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, secrets));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "api_key_ref") {
      result[key] = item ? maskKeyRef(String(item)) : "";
    } else if (SAFE_SECRET_STATUS_KEYS.has(key)) {
      result[key] = redactSensitive(item, secrets);
    } else if (TOKEN_STAT_KEYS.has(key)) {
      result[key] = redactSensitive(item, secrets);
    } else if (/api[_-]?key|authorization|secret|(?:^|[_-])token(?:$|[_-])/i.test(key)) {
      result[key] = item ? "[已脱敏]" : item;
    } else {
      result[key] = redactSensitive(item, secrets);
    }
  }
  return result;
}

/** 隐藏密钥引用中的敏感部分。 */
export function maskKeyRef(ref) {
  if (!ref) return "";
  if (ref.startsWith("env:")) return `env:${ref.slice(4, 7)}***`;
  return "[密钥引用已脱敏]";
}

/** 判断文本中是否包含敏感信息。 */
export function containsSensitiveText(text, extraSecrets = []) {
  const source = typeof text === "string" ? text : JSON.stringify(text);
  if (/sk-[A-Za-z0-9_-]{8,}/.test(source)) return true;
  if (/Bearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(source)) return true;
  return extraSecrets.filter(Boolean).some((secret) => source.includes(secret));
}

/** 将对象安全转换成 JSON 字符串。 */
export function safeJson(value) {
  return JSON.stringify(value, null, 2);
}
