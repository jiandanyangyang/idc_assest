/**
 * 华为 (VRP) 驱动解析器测试
 * 样本来自华为官方命令参考 display interface brief / display current-configuration interface
 * 重点验证：管理性关闭端口 PHY 列 *down → free（易错点）
 */
const HuaweiDriver = require('../services/portDiscovery/drivers/huawei');
const { parsePortsFromTable } = require('../services/portDiscovery/parser');
const { mapSpeed, mapStatus, inferPortType } = require('../services/portDiscovery/mapper');
const { buildAligned } = require('./alignedSample');

/** 华为 VRP display interface brief 典型输出（管理性关闭端口 PHY 显示 *down） */
const BRIEF_SAMPLE = buildAligned(
  ['Interface', 'PHY', 'Protocol'],
  [
    ['GigabitEthernet0/0/1', 'up', 'up'],
    ['GigabitEthernet0/0/2', '*down', 'down'],
    ['GigabitEthernet0/0/3', 'down', 'down'],
    ['MEth0/0/0', 'up', 'up'],
    ['NULL0', 'up', 'up(s)'],
  ]
);

/** display current-configuration interface 片段（用于解析 description） */
const CFG_SAMPLE = `#
interface GigabitEthernet0/0/1
 description Uplink to Core
 port link-type access
 port default vlan 10
#
interface GigabitEthernet0/0/2
#
return
`;

describe('华为驱动 - 状态映射与描述解析', () => {
  const drv = new HuaweiDriver({});

  test('vendor 标识为 huawei', () => {
    expect(drv.vendor).toBe('huawei');
    expect(drv._getPaginatorDisable()).toBe('screen-length 0 temporary');
  });

  test('display interface brief：*down（管理性关闭）→ free', () => {
    const ports = parsePortsFromTable('huawei', BRIEF_SAMPLE, { mapSpeed, mapStatus, inferPortType });
    const byName = Object.fromEntries(ports.map(p => [p.portName, p]));

    expect(byName['GigabitEthernet0/0/1'].status).toBe('occupied'); // up
    expect(byName['GigabitEthernet0/0/2'].status).toBe('free');     // *down → free（关键修复点）
    expect(byName['GigabitEthernet0/0/3'].status).toBe('free');     // down → free
  });

  test('_parseInterfaceDescriptions：提取端口描述', () => {
    const map = drv._parseInterfaceDescriptions(CFG_SAMPLE);
    expect(map['GigabitEthernet0/0/1']).toBe('Uplink to Core');
    expect(map['GigabitEthernet0/0/2']).toBeUndefined(); // 无 description 行
  });

  test('_parseVlanTable：display port vlan 解析 PVID', () => {
    const vlanRaw = `Port Link Type PVID Trunk VLAN List
GigabitEthernet0/0/1 access 10 -
GigabitEthernet0/0/2 trunk 1 1-4094
`;
    const map = drv._parseVlanTable(vlanRaw);
    expect(map['GigabitEthernet0/0/1']).toBe(10);
    expect(map['GigabitEthernet0/0/2']).toBe(1);
  });
});
