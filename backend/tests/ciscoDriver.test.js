/**
 * Cisco (IOS / IOS-XE) 驱动解析器测试
 * 样本来自 Cisco 官方命令参考 / Catalyst show interfaces status 真实输出格式
 */
const CiscoDriver = require('../services/portDiscovery/drivers/cisco');
const { parsePortsFromTable } = require('../services/portDiscovery/parser');
const { mapSpeed, mapStatus, inferPortType } = require('../services/portDiscovery/mapper');
const { DRIVERS, createDriver } = require('../services/portDiscovery');
const { buildAligned } = require('./alignedSample');

/** Cisco Catalyst show interfaces status 典型输出 */
const STATUS_SAMPLE = buildAligned(
  ['Port', 'Name', 'Status', 'Vlan', 'Duplex', 'Speed', 'Type'],
  [
    ['Gi1/0/1', '', 'connected', '1', 'a-full', 'a-1000', '10/100/1000BaseTX'],
    ['Gi1/0/2', '', 'notconnect', '1', 'auto', 'auto', '10/100/1000BaseTX'],
    ['Gi1/0/3', '', 'disabled', '10', 'auto', 'auto', '10/100/1000BaseTX'],
    ['Te1/0/1', '', 'connected', 'trunk', 'full', '10G', '10GBaseT'],
    ['Po1', '', 'connected', 'trunk', 'full', 'a-10G', 'Port-channel'],
    ['Vlan1', '', 'up', '1', 'auto', 'auto', 'EtherSVI'],
  ]
);

/** Cisco show ip interface brief 典型输出（路由器/无 switchport 回退） */
const BRIEF_SAMPLE = buildAligned(
  ['Interface', 'IP-Address', 'OK?', 'Method', 'Status', 'Protocol'],
  [
    ['Gi1/0/1', '192.168.1.1', 'YES', 'manual', 'up', 'up'],
    ['Gi1/0/2', 'unassigned', 'YES', 'unset', 'administratively down', 'down'],
  ]
);

/** Cisco show interfaces description 典型输出 */
const DESC_SAMPLE = buildAligned(
  ['Interface', 'Status', 'Protocol', 'Description'],
  [
    ['Gi1/0/1', 'up', 'up', 'Uplink to Core'],
    ['Gi1/0/3', 'up', 'up', 'To-Firewall'],
  ]
);

describe('Cisco 驱动 - 注册与解析', () => {
  const drv = new CiscoDriver({});

  test('注册表中已包含 cisco 驱动', () => {
    expect(DRIVERS.cisco).toBe(CiscoDriver);
    expect(createDriver('cisco', {})).toBeInstanceOf(CiscoDriver);
  });

  test('vendor 标识为 cisco', () => {
    expect(drv.vendor).toBe('cisco');
    expect(drv._getPaginatorDisable()).toBe('terminal length 0');
  });

  test('show interfaces status：状态/速率/VLAN/类型映射', () => {
    const ports = parsePortsFromTable('cisco', STATUS_SAMPLE, { mapSpeed, mapStatus, inferPortType });
    const byName = Object.fromEntries(ports.map(p => [p.portName, p]));

    // 物理口保留，Vlan 逻辑口被过滤
    expect(ports.map(p => p.portName)).toEqual(
      expect.arrayContaining(['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Te1/0/1', 'Po1'])
    );
    expect(ports.map(p => p.portName)).not.toEqual(expect.arrayContaining(['Vlan1']));

    expect(byName['Gi1/0/1']).toMatchObject({
      status: 'occupied',
      portSpeed: '1G',     // a-1000 → 1000 → 1G（自协商前缀已剥离）
      vlanId: 1,
      portType: 'RJ45',
    });
    expect(byName['Gi1/0/2']).toMatchObject({
      status: 'free',       // notconnect → free
      portSpeed: '1G',     // auto 无协商结果 → 按端口名回填标称速率
      vlanId: 1,
    });
    expect(byName['Gi1/0/3']).toMatchObject({
      status: 'fault',      // disabled → fault
      vlanId: 10,
    });
    expect(byName['Te1/0/1']).toMatchObject({
      status: 'occupied',
      portSpeed: '10G',
      vlanId: null,        // trunk 口无单一 PVID
    });
    expect(byName['Po1'].portType).toBe('SFP+'); // Port-channel 聚合口保留
  });

  test('show ip interface brief 回退：administratively down → free', () => {
    const ports = parsePortsFromTable('cisco', BRIEF_SAMPLE, { mapSpeed, mapStatus, inferPortType });
    const byName = Object.fromEntries(ports.map(p => [p.portName, p]));
    expect(byName['Gi1/0/1'].status).toBe('occupied');
    expect(byName['Gi1/0/2'].status).toBe('free'); // administratively down → free
  });

  test('show interfaces description 解析为 portName → description 映射', () => {
    const map = drv._parseDescriptions(DESC_SAMPLE);
    expect(map['Gi1/0/1']).toBe('Uplink to Core');
    expect(map['Gi1/0/3']).toBe('To-Firewall');
  });

  test('空输入返回空数组', () => {
    expect(parsePortsFromTable('cisco', '', { mapSpeed, mapStatus, inferPortType })).toEqual([]);
  });
});
