/**
 * 端口自动采集 - 类型/速率/状态映射器
 * 将厂商特定值映射为系统标准枚举
 */

/**
 * 端口速率映射（厂商值 → DevicePort.portSpeed 枚举）
 */
const SPEED_MAP = {
  // 华为/思科/华三/锐捷 通用
  '10M': '100M',
  '100M': '100M',
  '1G': '1G',
  '1000M': '1G',
  'GE': '1G',
  '10G': '10G',
  '10000M': '10G',
  '10GE': '10G',
  '25G': '25G',
  '25GE': '25G',
  '40G': '40G',
  '40GE': '40G',
  '50G': '50G',
  '100G': '100G',
  '100GE': '100G',
  '200G': '200G',
  '400G': '400G',
  '800G': '800G',
  // 通用
  'auto': null,
  'Auto': null,
  'unknown': null,
  '-': null,
};

/**
 * 端口状态映射（厂商值 → DevicePort.status 枚举）
 */
const STATUS_MAP = {
  // 华为 display interface brief: up / down / *down(管理性关闭)
  'up': 'occupied',
  'UP': 'occupied',
  'down': 'free',
  'DOWN': 'free',
  // 华为管理性关闭端口 PHY 列显示 *down（已核实 VRP 官方文档）
  '*down': 'free',
  'admdown': 'free',
  'ADMDOWN': 'free',
  // 思科 show interfaces status: connected / notconnect / disabled / err-disabled
  'connected': 'occupied',
  'notconnect': 'free',
  'disabled': 'fault',
  'err-disabled': 'fault',
  // 思科 show ip interface brief 的状态列（管理性关闭时）
  'administratively down': 'free',
  // 华三/锐捷
  'admin down': 'free',
  'admin_down': 'free',
};

/**
 * 端口类型推断（根据端口名称前缀）
 * 不同厂商端口命名模式不同，这里做通用规则
 */
const PORT_TYPE_RULES = [
  // 聚合口（LACP / 手工聚合）：成员口多为光口，统一标记为 SFP+（无专门枚举值）
  { pattern: /^(Po|Port-channel|AggregatePort|BAGG|RAGG|Bridge-Agg|Route-Agg|Eth-Trunk)/i, type: 'SFP+' },
  // H3C Comware 端口名缩写（FGE=FortyGigE / HGE=HundredGigE / TGE=TwentyFiveGigE / M-GE=管理口）
  { pattern: /^M-GE|^MGMT|^MEth/i, type: 'MGMT' },
  { pattern: /^HGE|^HundredGig/i, type: 'QSFP28' },
  { pattern: /^FGE|^FortyGig/i, type: 'QSFP+' },
  { pattern: /^TGE|^TwentyFiveGig|^25Gig/i, type: 'SFP28' },
  { pattern: /^GE|^GigabitEthernet|^gi/i, type: 'RJ45' },
  { pattern: /^XGE|^10GE|^TenGigE|^Te/i, type: 'SFP+' },
  { pattern: /^25GE/i, type: 'SFP28' },
  { pattern: /^40GE|^FortyGig/i, type: 'QSFP+' },
  { pattern: /^100GE|^HundredGig/i, type: 'QSFP28' },
  { pattern: /^Eth|^Ethernet|^eth/i, type: 'RJ45' },
  { pattern: /^SFP/i, type: 'SFP' },
  { pattern: /^XG/i, type: 'SFP+' },
  { pattern: /^MGMT|^MEth/i, type: 'MGMT' },
  { pattern: /^Vlan|^VLAN/i, type: 'RJ45' }, // 三层逻辑接口
  { pattern: /^Loopback/i, type: 'RJ45' },
  { pattern: /^NULL/i, type: 'RJ45' },
];

/**
 * 映射端口速率
 * @param {string} raw - 厂商原始速率值
 * @returns {string|null}
 */
function mapSpeed(raw) {
  if (!raw) return null;
  let trimmed = String(raw).trim();
  // Cisco show interfaces status 协商速率带 "a-" 前缀（如 a-1000 / a-10G），先剥离
  trimmed = trimmed.replace(/^a-/i, '').trim();
  if (SPEED_MAP[trimmed]) return SPEED_MAP[trimmed];
  // 尝试直接匹配数字
  const m = trimmed.match(/(\d+)(M|G)/i);
  if (m) {
    const num = parseInt(m[1]);
    const unit = m[2].toUpperCase();
    const gbps = unit === 'G' ? num : num / 1000;
    const candidates = [800, 400, 200, 100, 50, 40, 25, 10, 1];
    const closest = candidates.find(c => gbps >= c);
    if (closest) return `${closest}G`;
  }
  return null;
}

/**
 * 映射端口状态
 * @param {string} raw - 厂商原始状态值
 * @returns {string} occupied / free / fault / null
 */
function mapStatus(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  if (STATUS_MAP[key] !== undefined) return STATUS_MAP[key];
  // 尝试小写匹配
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(STATUS_MAP)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * 根据端口名称推断端口类型
 * @param {string} portName - 端口名称
 * @returns {string} DevicePort.portType 值
 */
function inferPortType(portName) {
  if (!portName) return 'RJ45';
  for (const rule of PORT_TYPE_RULES) {
    if (rule.pattern.test(portName)) return rule.type;
  }
  return 'RJ45';
}

/**
 * 按端口名推断标称速率（接口规格）
 *
 * 背景：display interface brief 的 Speed 列是链路协商结果，端口 DOWN 时
 * 链路未建立、自协商无结果，Comware 显示 auto（华为显示 --），拿不到速率。
 * 此时按端口名推断"接口规格"作为标称速率回填——与 DevicePort.portSpeed
 * 字段的语义（端口规格）一致；协商速率优先，标称速率仅兜底。
 *
 * 注意：
 * - 标称速率 ≠ 实际协商速率（如 10G 口插 1G 光模块协商跑 1G，UP 口以协商值为准）；
 * - 聚合口/三层逻辑口的速率由成员口或三层属性决定，返回 null 不推断；
 * - 已知误标场景：10G Base-T 电口在 Comware 中命名仍为 GE，会被标为 1G。
 *
 * @param {string} portName - 端口名（H3C 缩写 GE/XGE/FGE/HGE 或华为全称）
 * @returns {string|null} 标称速率（1G/10G/25G/40G/100G）或 null（无法推断/不适用）
 */
const NOMINAL_SPEED_RULES = [
  // 聚合口 / 逻辑口：不适用（放在最前，避免 Eth-Trunk 被下面的 Eth 规则误吞）
  { pattern: /^(RAGG|BAGG|Bridge-Agg|Route-Agg|Eth-Trunk|Vlan|Vlanif|VLANIF|LoopBack|Loopback|InLoop|NULL|Tunnel|Register|REG\d)/i, speed: null },
  // 管理口
  { pattern: /^(M-GE|MGE|MEth|MGMT)/i, speed: '1G' },
  // 100G（放在 10GE 前面，避免 ^10GE 前缀混淆）
  { pattern: /^(HGE|HundredGig|100GE)/i, speed: '100G' },
  // 40G
  { pattern: /^(FGE|FortyGig|FortyGigE|40GE)/i, speed: '40G' },
  // 25G
  { pattern: /^(TGE|TwentyFiveGig|25GE)/i, speed: '25G' },
  // 10G（含华为 XGigabitEthernet、拆分口 XGE1/0/49:1）
  { pattern: /^(XGE|XGigabitEthernet|TenGigE|Ten-GigabitEthernet|10GE|XG\b)/i, speed: '10G' },
  // 1G 千兆（GE 放最后：^GE 不会误吞 XGE/FGE 等以其他字母开头的缩写）
  // 思科缩写 Gi = GigabitEthernet，同样按 1G 推断
  { pattern: /^(GE|Gi|GigabitEthernet|Ethernet|Eth)/i, speed: '1G' },
];

function inferNominalSpeed(portName) {
  if (!portName) return null;
  for (const rule of NOMINAL_SPEED_RULES) {
    if (rule.pattern.test(portName)) return rule.speed;
  }
  return null;
}

module.exports = {
  mapSpeed,
  mapStatus,
  inferPortType,
  inferNominalSpeed,
};
