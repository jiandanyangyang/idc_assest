/**
 * 测试辅助：生成"按表头列位置对齐"的 CLI 表格文本
 * 贴近真实网络设备（VRP/IOS/RGOS）的定宽输出，配合 parser 的定宽切片使用。
 */
function buildAligned(headerCols, rows) {
  const widths = headerCols.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] || '').length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const lines = [headerCols.map((h, i) => pad(h, widths[i])).join('  ')];
  for (const r of rows) lines.push(r.map((c, i) => pad(c || '', widths[i])).join('  '));
  return lines.join('\n');
}

module.exports = { buildAligned };
