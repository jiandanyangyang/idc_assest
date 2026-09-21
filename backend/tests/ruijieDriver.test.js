/**
 * 锐捷 (RGOS) 驱动解析器测试
 * 样本来自锐捷官方命令参考 / RGOS show interfaces status 真实输出格式
 * 注意：RGOS 的 Status 列使用 up/down/err-disabled（与 Cisco 的 connected/notconnect 不同）
 */
const RuijieDriver = require('../services/portDiscovery/drivers/ruijie');
const { parsePortsFromTable } = require('../services/portDiscovery/parser');
const { mapSpeed, mapStatus, inferPortType } = require('../services/portDiscovery/mapper');
const { DRIVERS, createDriver } = require('../services/portDiscovery');
const { buildAligned } = require('./alignedSample');

/** 锐捷 RGOS show interfaces status 典型输出（端口名含空格，如 GigabitEthernet 0/1） */
const STATUS_SAMPLE = buildAligned(
  ['Interface', 'Status', 'Vlan', 'Duplex', 'Speed', 'Type'],
  [
    ['GigabitEthernet 0/1', 'up', '1', 'Full', '1000M', 'copper'],
    ['GigabitEthernet 0/2', 'down', '1', 'Auto', 'auto', 'copper'],
    ['GigabitEthernet 0/3', 'err-disabled', '10', 'Auto', 'auto', 'copper'],
    ['TenGigabitEthernet 0/25', 'up', 'trunk', 'Full', '10G', '10GBaseT'],
    ['AggregatePort 1', 'up', 'trunk', 'Full', '10G', 'AggregatePort'],
    ['Vlan1', 'up', '1', 'Auto', 'auto', 'EtherSVI'],
  ]
);

describe('Ruijie 驱动 - 注册与解析', () => {
  const drv = new RuijieDriver({});

  test('注册表中已包含 ruijie 驱动', () => {
    expect(DRIVERS.ruijie).toBe(RuijieDriver);
    expect(createDriver('ruijie', {})).toBeInstanceOf(RuijieDriver);
  });

  test('vendor 标识为 ruijie，关分页命令为 terminal length 0', () => {
    expect(drv.vendor).toBe('ruijie');
    expect(drv._getPaginatorDisable()).toBe('terminal length 0');
  });

  test('show interfaces status：up/down/err-disabled 状态映射正确', () => {
    const ports = parsePortsFromTable('ruijie', STATUS_SAMPLE, { mapSpeed, mapStatus, inferPortType });
    const byName = Object.fromEntries(ports.map(p => [p.portName, p]));

    // 物理口保留（含 AggregatePort 聚合口），Vlan 逻辑口被过滤
    expect(ports.map(p => p.portName)).toEqual(
      expect.arrayContaining(['GigabitEthernet 0/1', 'GigabitEthernet 0/2', 'GigabitEthernet 0/3', 'TenGigabitEthernet 0/25', 'AggregatePort 1'])
    );
    expect(ports.map(p => p.portName)).not.toEqual(expect.arrayContaining(['Vlan1']));

    expect(byName['GigabitEthernet 0/1']).toMatchObject({
      status: 'occupied',
      portSpeed: '1G',    // 1000M → 1G
      vlanId: 1,
      portType: 'RJ45',
    });
    expect(byName['GigabitEthernet 0/2']).toMatchObject({
      status: 'free',      // down → free
      portSpeed: '1G',     // auto → 按端口名回填
      vlanId: 1,
    });
    expect(byName['GigabitEthernet 0/3']).toMatchObject({
      status: 'fault',     // err-disabled → fault
      vlanId: 10,
    });
    expect(byName['TenGigabitEthernet 0/25']).toMatchObject({
      status: 'occupied',
      portSpeed: '10G',
      vlanId: null,
    });
  });

  test('空输入返回空数组', () => {
    expect(parsePortsFromTable('ruijie', '', { mapSpeed, mapStatus, inferPortType })).toEqual([]);
  });
});
