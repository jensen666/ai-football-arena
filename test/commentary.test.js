import test from "node:test";
import assert from "node:assert/strict";
import { buildCommentary, formatMinute, formatPlayerLabel } from "../src/commentary.js";

const homeSix = { team_id: "home", shirt: 6, name: "主6号", position: "DM" };
const awayTen = { team_id: "away", shirt: 10, name: "客10号", position: "ST" };

/** 规则模板生成电视式动作播报。 */
test("规则模板生成电视式动作播报", () => {
  assert.equal(buildCommentary({ action_type: "tackle_won", team_id: "home", actor: homeSix, target: awayTen }), "主队 6 号上抢成功，断下了客队 10 号的脚下球。");
  assert.equal(buildCommentary({ action_type: "pass_completed", team_id: "home", actor: homeSix, target: awayTen }), "主队 6 号把球交给客队 10 号。");
  assert.equal(buildCommentary({ action_type: "shot", team_id: "away", actor: awayTen }), "客队 10 号起脚射门。");
  assert.equal(buildCommentary({ action_type: "goal", team_id: "away", actor: awayTen }), "客队 10 号破门得分！");
});

/** 缺失球员信息时播报模板应安全回退。 */
test("播报模板缺失球员信息时安全回退", () => {
  assert.equal(formatPlayerLabel(null, "home"), "主队球员");
  assert.equal(formatMinute(125), "2'");
  assert.equal(buildCommentary({ action_type: "corner_kick", team_id: "away" }), "客队获得角球。");
});
