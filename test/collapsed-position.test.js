const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const content = fs.readFileSync("src/content.js", "utf8");
const styles = fs.readFileSync("src/panel.css", "utf8");

test("浮层最小化后复用 Fomo 持仓汇总并隐藏 Token 信息", () => {
  assert.match(content, /data-role="collapsed-position"/);
  assert.match(content, /function positionSummary\(holders\)/);
  assert.match(content, /replaceChildren\(positionSummary\(holders\)\)/);
  assert.match(content, /renderCollapsedPosition\(view, currentData\.holders\)/);
  assert.match(content, /core\.preciseUsd\(holders\.fomoPositionValue\)/);
  assert.match(styles, /\.fomo-collapsed-position\s*\{\s*display: none;/);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-collapsed-position\s*\{\s*display: block;/);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-token-avatar,\s*\.fomo-panel\.collapsed \.fomo-token-copy\s*\{\s*display: none;/);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-position-summary-copy small\s*\{\s*display: none;/);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-header\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 28px 28px;/s);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-position-summary\s*\{[^}]*border: 0;[^}]*background: transparent;[^}]*gap: 8px;/s);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-side-panel,\s*\.fomo-panel\.collapsed \.fomo-collapse\s*\{[^}]*position: static;[^}]*border-radius: 8px;/s);
  const collapsedLabelStyles = styles.match(/\.fomo-panel\.collapsed \.fomo-position-summary-copy span\s*\{[^}]*\}/s);
  assert.ok(collapsedLabelStyles);
  assert.match(collapsedLabelStyles[0], /white-space: nowrap;/);
  assert.doesNotMatch(collapsedLabelStyles[0], /ellipsis/);
  assert.doesNotMatch(styles, /\.fomo-panel\.collapsed \.fomo-position-summary-metrics\s*\{\s*display: contents;/s);
  assert.match(styles, /\.fomo-panel\.collapsed \.fomo-position-summary\.limited \.fomo-position-summary-copy span\s*\{\s*font-size: 9px;/s);
});
