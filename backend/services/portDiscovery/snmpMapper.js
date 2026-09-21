/**
 * 端口自动采集 - SNMP IF-MIB 表数据 → 统一端口结构（纯函数，无网络依赖，便于单测）
 *
 * 输入为各列 OID walk 结果：{ [ifIndex]: value }
 * 输出结构与 SSH 驱动一致：{ portName, portType, portSpeed, status, description, vlanId }
 */
const { mapSpeed, mapStatus, inferPortType, inferNominalSpeed } = require('./mapper');

/**
 * 保留的接口类型（IANAifType）
 * 只保留物理以太口、聚合口与 VLAN 虚拟口，过滤 Loopback / Tunnel / Null 等无意义接口
 */
const KEEP_IF_TYPES = new Set([
  6,   // ethernetCsmacd（绝大多数物理口）
  53,  // propVirtual（部分厂商聚合口 / 三层虚拟口）
  117, // gigabitEthernet（思科等历史固件使用）
  135, // l2vlan（VLAN 子接口）
  136, // l3ipvlan（Vlanif 三层口）
  161, // ieee8023adLag（链路聚合）
]);

/** ifOperStatus → 系统状态原始值 */
const OPER_STATUS_TEXT = {
  1: 'up',
  2: 'down',
  3: 'testing',
};

/** 名称为空的接口跳过；NULL 接口过滤（与 SSH 驱动行为一致） */
function _isSkipName(name) {
  return !name || /^NULL/i.test(name);
}

/**
 * 将 ifHighSpeed（Mbps）映射为系统速率枚举
 * 协商速率为 0（口 DOWN 未链路协商）时返回 null，由标称速率兜底
 * @param {number} mbps
 * @returns {string|null}
 */
function _mapHighSpeed(mbps) {
  if (!mbps || mbps <= 0) return null;
  return mapSpeed(`${mbps}M`);
}

/**
 * 从 SNMP 表数据构建统一端口列表
 *
 * @param {Object} tables - 各列 walk 结果（键为 ifIndex 字符串）
 * @param {Object<string, string|number>} tables.ifName
 * @param {Object<string, string|number>} [tables.ifDescr] - ifName 缺失时的回退
 * @param {Object<string, number>} [tables.ifType]
 * @param {Object<string, number>} [tables.ifOperStatus]
 * @param {Object<string, number>} [tables.ifAdminStatus]
 * @param {Object<string, number>} [tables.ifHighSpeed] - Mbps
 * @param {Object<string, number>} [tables.ifSpeed] - bps（ifHighSpeed 缺失时的回退）
 * @param {Object<string, string|number>} [tables.ifAlias] - 接口描述
 * @param {Object<string, number>} [pvidByIfIndex] - Q-BRIDGE MIB dot1qPvid（ifIndex → PVID）
 * @returns {Array<{ portName, portType, portSpeed, status, description, vlanId }>}
 */
function buildPortsFromSnmpTables(tables, pvidByIfIndex = {}) {
  const {
    ifName = {}, ifDescr = {}, ifType = {}, ifOperStatus = {},
    ifAdminStatus = {}, ifHighSpeed = {}, ifSpeed = {}, ifAlias = {},
  } = tables || {};

  // 以 ifName ∪ ifDescr 的 ifIndex 并集为遍历基准
  const indexSet = new Set([...Object.keys(ifName), ...Object.keys(ifDescr)]);
  const ports = [];

  for (const idx of indexSet) {
    const name = String(ifName[idx] ?? ifDescr[idx] ?? '').trim();
    if (_isSkipName(name)) continue;

    // 类型过滤：ifType 缺失时保守保留（部分老设备 walk 不到 ifType）
    const type = Number(ifType[idx]);
    if (ifType[idx] !== undefined && !KEEP_IF_TYPES.has(type)) continue;

    // 状态：oper up/down/testing + admin down（管理关闭）
    let statusText = OPER_STATUS_TEXT[Number(ifOperStatus[idx])];
    if (Number(ifAdminStatus[idx]) === 2) statusText = 'admdown';
    let status = statusText === 'testing' ? 'fault' : mapStatus(statusText);

    // 速率：协商速率（ifHighSpeed Mbps）优先 → ifSpeed（bps）回退 → 标称速率兜底
    let portSpeed = _mapHighSpeed(Number(ifHighSpeed[idx]));
    if (!portSpeed && ifSpeed[idx] !== undefined) {
      portSpeed = mapSpeed(`${Math.round(Number(ifSpeed[idx]) / 1e6)}M`);
    }
    if (!portSpeed) portSpeed = inferNominalSpeed(name);

    ports.push({
      portName: name,
      portType: inferPortType(name),
      portSpeed: portSpeed || null,
      status: status || null,
      description: ifAlias[idx] !== undefined ? String(ifAlias[idx]).trim() || null : null,
      vlanId: pvidByIfIndex[idx] !== undefined ? Number(pvidByIfIndex[idx]) : undefined,
    });
  }

  // 按端口名自然排序（GE1/0/1 < GE1/0/2 < GE1/0/10），保证预览与落库顺序稳定
  ports.sort((a, b) => a.portName.localeCompare(b.portName, undefined, { numeric: true }));
  return ports;
}

/**
 * 将表数据还原为可读文本（诊断用原始输出，结构对齐 SNMP walk 结果）
 * @param {Object} tables
 * @returns {string}
 */
function buildRawTableText(tables) {
  const {
    ifName = {}, ifDescr = {}, ifType = {}, ifOperStatus = {},
    ifAdminStatus = {}, ifHighSpeed = {}, ifSpeed = {}, ifAlias = {},
  } = tables || {};
  const indexSet = new Set([...Object.keys(ifName), ...Object.keys(ifDescr)]);
  const lines = [
    'ifIndex  ifName/Descr           Type  Oper   Admin  HighSpeed(Mbps)  Alias',
    '-------  ---------------------  ----  -----  -----  ---------------  -----',
  ];
  const indexes = [...indexSet].sort((a, b) => Number(a) - Number(b));
  for (const idx of indexes) {
    const name = String(ifName[idx] ?? ifDescr[idx] ?? '');
    lines.push([
      String(idx).padEnd(8),
      name.padEnd(22).slice(0, 22),
      String(ifType[idx] ?? '-').padEnd(5),
      String(OPER_STATUS_TEXT[Number(ifOperStatus[idx])] ?? ifOperStatus[idx] ?? '-').padEnd(6),
      String(ifAdminStatus[idx] ?? '-').padEnd(6),
      String(ifHighSpeed[idx] ?? (ifSpeed[idx] !== undefined ? Math.round(Number(ifSpeed[idx]) / 1e6) : '-')).padEnd(16),
      String(ifAlias[idx] ?? ''),
    ].join('  '));
  }
  return lines.join('\n');
}

module.exports = {
  KEEP_IF_TYPES,
  OPER_STATUS_TEXT,
  buildPortsFromSnmpTables,
  buildRawTableText,
};
