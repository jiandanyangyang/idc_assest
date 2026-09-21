/**
 * 端口自动采集 - CLI 输出解析器
 * 解析厂商 SSH CLI 返回的表格文本，提取为统一的端口数组
 *
 * 典型输入：华为 display interface brief / 思科 show interfaces status
 * 典型输出：[{ portName, status, speed, vlan, description }]
 *
 * 解析策略：CLI 表格多为"定宽对齐"，相邻列之间可能只有 1 个空格
 *（如华为 PHY 列的 "*down" 与 Protocol 列的 "down"）。
 * 若按连续空白切分（\s{2,}），*down 与 down 会被合并成一列，导致状态列错位。
 * 因此这里采用"按表头列起始位置定宽切片"，对任意对齐表格与含空格端口名都稳健。
 */
const { inferNominalSpeed } = require('./mapper');

/**
 * 拆分一行表格为列（仅用于表头识别，数据行改用定宽切片）
 * @param {string} line - 表格行
 * @returns {string[]}
 */
function splitColumns(line) {
  return line.trim().split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
}

/**
 * 判断是否为表头分隔行（如 "----  ----" 或 "+----+----+"）
 * @param {string} line
 * @returns {boolean}
 */
function isSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // 纯连字符/下划线/加号/竖线
  return /^[+\-_|=\s]+$/.test(trimmed);
}

/**
 * 找到表头行在数组中的索引，返回列名数组
 * 启发式：以首列包含 "Interface"/"Port" 或 "名称"/"接口" 等关键字作为表头
 * @param {string[]} lines - 经过显示化（去 More 标记、trim）后的行数组
 * @returns {{ headerIndex: number, columns: string[] } | null}
 */
function findHeader(lines) {
  const keywords = [
    /interface/i, /port/i, /ifindex/i,
    /接口/, /名称/,
  ];

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i].trim();
    if (!line || isSeparatorLine(line)) continue;
    const cols = splitColumns(line);
    if (cols.length < 2) continue;
    if (keywords.some(re => re.test(cols[0]))) {
      return { headerIndex: i, columns: cols };
    }
  }
  return null;
}

/**
 * 根据表头行与各列名，计算每列在原始行中的起始/结束位置（定宽切片用）
 * @param {string} headerLine - 未 trim 的表头原始行（保留对齐空格）
 * @param {string[]} columnNames - splitColumns 得到的列名（已 trim）
 * @returns {Array<{start:number, end:number}>}
 */
function computeColumnRanges(headerLine, columnNames) {
  const ranges = [];
  let searchFrom = 0;
  for (const name of columnNames) {
    let idx = headerLine.indexOf(name, searchFrom);
    if (idx === -1) {
      // 列名在原始行中找不到（极少见，如列名被折叠），全局再找一次
      idx = headerLine.indexOf(name);
    }
    if (idx === -1) {
      // 实在找不到：放到行尾，切片为空（不阻断其它列解析）
      ranges.push({ start: headerLine.length, end: headerLine.length });
      continue;
    }
    ranges.push({ start: idx, end: headerLine.length });
    searchFrom = idx + name.length;
  }
  // 每列结束位置 = 下一列起始位置
  for (let i = 0; i < ranges.length; i++) {
    const next = ranges[i + 1];
    if (next) ranges[i].end = next.start;
  }
  return ranges;
}

/**
 * 按列起始位置切片一行（定宽对齐表格比按空白切分更稳）
 * @param {string} line - 未 trim 的原始行
 * @param {Array<{start:number, end:number}>} ranges
 * @returns {string[]}
 */
function sliceByRanges(line, ranges) {
  return ranges.map(r => line.slice(r.start, r.end).replace(/[<>]/g, '').trim());
}

/**
 * 解析通用表格输出
 * @param {string} raw - CLI 命令原始输出
 * @returns {{ headerIndex: number, columns: string[], rows: string[][] }}
 */
function parseTable(raw) {
  if (!raw || typeof raw !== 'string') {
    return { headerIndex: -1, columns: [], rows: [] };
  }

  // 统一换行符 + 清理分页标记（VRP 的 <--- More ---> 与 Cisco/Ruijie 的 ---- More ----）
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(/<*--+\s*More\s*-*--+>/gi, ' ')
    .replace(/\r/g, '');

  const rawLines = normalized.split('\n');
  // 显示化行：仅用于表头识别 / 分隔线判断（去 <> 与首尾空白）
  const dispLines = rawLines.map(l => l.replace(/[<>]/g, '').trim());

  const headerInfo = findHeader(dispLines);
  if (!headerInfo) {
    return { headerIndex: -1, columns: [], rows: [] };
  }

  const { headerIndex, columns } = headerInfo;
  const ranges = computeColumnRanges(rawLines[headerIndex], columns);

  const rows = [];
  for (let i = headerIndex + 1; i < rawLines.length; i++) {
    const disp = dispLines[i];
    if (!disp) continue;
    if (isSeparatorLine(disp)) continue;
    // 遇到常见的结束标记停止
    if (/^\s*(Total|Sum|共)/i.test(disp)) continue;
    const cells = sliceByRanges(rawLines[i], ranges);
    if (cells.length >= 2 && cells[0]) {
      rows.push(cells);
    }
  }

  return { headerIndex, columns, rows };
}

/**
 * 厂商感知的纯逻辑/虚拟接口过滤规则
 * - 华为：仅过滤 NULLME（Vlanif / LoopBack 等三层口在采集侧保留，便于三层口管理）
 * - 思科 / 锐捷：过滤 Vlan / LoopBack / Null / Tunnel / Async / Vif / Virtual 等三层/虚拟口
 * 注意：过滤以端口名为依据，与解析层解耦；驱动层 collectPorts 仍保留同等过滤作为兜底
 */
const LOGICAL_FILTERS = {
  huawei: /^NULLME/i,
  cisco: /^(Vlan|VLAN|Loop|LoopBack|Null|NULL|Tunnel|Async|Vif|Virtual)/i,
  ruijie: /^(Vlan|VLAN|Loop|LoopBack|Null|NULL|Tunnel|Async|Vif|Virtual)/i,
};

/**
 * 按厂商自定义解析端口列表
 * 不同厂商 display interface brief 的列顺序略有差异，这里做定向处理
 * @param {string} vendor - 厂商标识 huawei / cisco / h3c / ruijie
 * @param {string} raw - CLI 原始输出
 * @param {Function} mapper - { mapSpeed, mapStatus, inferPortType }
 * @returns {Array<{ portName, portType, portSpeed, status, description, vlanId }>}
 */
function parsePortsFromTable(vendor, raw, mapper) {
  const { headerIndex, columns, rows } = parseTable(raw);

  if (headerIndex === -1 || rows.length === 0) {
    return [];
  }

  // 列名归一化（处理中英文 + 厂商差异）
  // 注意：华为 display interface brief 的状态列叫 "PHY"，思科/H3C 叫 "Status"/"Link"
  const colMap = {};
  columns.forEach((name, idx) => {
    const n = name.toLowerCase();
    if (/interface|ifname|port|接口|名称/i.test(name)) colMap.name = idx;
    else if (/status|state|状态|^phy$|link/i.test(name)) colMap.status = idx;
    else if (/speed|速率/i.test(name)) colMap.speed = idx;
    else if (/description|desc|描述/i.test(name)) colMap.desc = idx;
    else if (/vlan|pvid/i.test(name)) colMap.vlan = idx;
    else if (/type|类型/i.test(name)) colMap.type = idx;
    else if (/index/i.test(name)) colMap.index = idx;
  });

  const logicalRe = LOGICAL_FILTERS[vendor];
  const result = [];

  for (const row of rows) {
    const portName = colMap.name !== undefined ? row[colMap.name] : row[0];
    if (!portName || /^\s*$/.test(portName)) continue;

    // 过滤纯逻辑/虚拟接口（按厂商策略）
    if (logicalRe && logicalRe.test(portName)) continue;

    const rawStatus = colMap.status !== undefined ? row[colMap.status] : null;
    const rawSpeed = colMap.speed !== undefined ? row[colMap.speed] : null;
    const desc = colMap.desc !== undefined ? row[colMap.desc] : null;
    const rawVlan = colMap.vlan !== undefined ? row[colMap.vlan] : null;

    const portSpeed = (rawSpeed ? mapper.mapSpeed(rawSpeed) : null) || inferNominalSpeed(portName);
    const status = mapper.mapStatus(rawStatus);
    const portType = colMap.type !== undefined ? inferPortTypeByVendor(vendor, row[colMap.type], portName) : mapper.inferPortType(portName);
    const vlanId = parseVlan(rawVlan);

    result.push({
      portName,
      portType,
      portSpeed,
      status,
      description: desc || null,
      vlanId,
    });
  }

  return result;
}

/**
 * 根据厂商和端口类型列值推断 DevicePort.portType
 * @param {string} vendor
 * @param {string} rawType - 厂商输出的 type 列
 * @param {string} portName
 * @returns {string}
 */
function inferPortTypeByVendor(vendor, rawType, portName) {
  if (rawType) {
    const t = rawType.toLowerCase();
    if (/sfp28|25g|25ge/.test(t)) return 'SFP28';
    if (/qsfp28|100g|100ge/.test(t)) return 'QSFP28';
    if (/qsfp\+|40g|40ge/.test(t)) return 'QSFP+';
    if (/sfp\+|10g|10ge|xge/.test(t)) return 'SFP+';
    if (/sfp/.test(t)) return 'SFP';
    if (/copper|rj45|ge|gigabit|ethernet/i.test(t)) return 'RJ45';
  }
  return require('./mapper').inferPortType(portName);
}

/**
 * 解析 VLAN 字符串为数字
 * 华为 display interface brief 的 vlan 列可能是 "1,2,3" 多 VLAN 或 "-"
 * 取第一个 VLAN 作为主 VLAN
 * @param {string} raw
 * @returns {number|null}
 */
function parseVlan(raw) {
  if (!raw || raw === '-' || raw === '--' || raw.toLowerCase() === 'none') return null;
  const m = String(raw).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = {
  parseTable,
  parsePortsFromTable,
  splitColumns,
};
