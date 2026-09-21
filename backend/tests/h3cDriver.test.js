/**
 * H3C (Comware) 驱动解析器测试
 * 使用贴近真实 display brief interface 输出的样本，不依赖真实设备
 */
const H3CDriver = require('../services/portDiscovery/drivers/h3c');
const { inferPortType } = require('../services/portDiscovery/mapper');
const { DRIVERS, createDriver } = require('../services/portDiscovery');

/** Comware 7 典型输出样本（route + bridge 两段混合） */
const SAMPLE = ` H3C Comware Software, Version 7.1.070, Release 6127P20
Copyright (c) 2004-2021 New H3C Technologies Co., Ltd. All rights reserved.

<H3C-Core>display brief interface
Brief information on interfaces in route mode:
Link: ADM - administratively down; St(s) - state
Interface                Link Protocol Primary IP      Description
GE1/0/48                 UP   UP       192.168.56.10   uplink-to-core
Vlan1                    UP   UP       --              --
InLoop0                  UP   UP(s)    --              --
NULL0                    UP   UP(s)    --              --

Brief information on interfaces in bridge mode:
Link: ADM - administratively down; St(s) - state
Speed: (a) - auto
Duplex: (a) - auto; (A) - auto; (H) - half
Type: A - access; T - trunk; H - hybrid
Interface                Link Speed   Duplex Type PVID Description
FGE1/0/53                UP   40G(a)  Full   T    100  to-core
XGE1/0/49                DOWN auto    Auto   A    1    --
GE1/0/1                  UP   1G(a)   Full   A    10   server-01
GE1/0/2                  ADM  auto    Auto   H    1    reserved
`;

describe('H3C 驱动 - display brief interface 解析', () => {
  const drv = new H3CDriver({});

  test('注册表中已包含 h3c 驱动', () => {
    expect(DRIVERS.h3c).toBe(H3CDriver);
    expect(createDriver('h3c', {})).toBeInstanceOf(H3CDriver);
  });

  test('解析 route + bridge 混合输出，过滤纯逻辑接口', () => {
    const ports = drv._parseBriefInterfaces(SAMPLE);
    const names = ports.map(p => p.portName);

    // 物理口 + 管理口保留
    expect(names).toEqual(
      expect.arrayContaining(['GE1/0/48', 'FGE1/0/53', 'XGE1/0/49', 'GE1/0/1', 'GE1/0/2'])
    );
    // Vlan / InLoop / NULL 等逻辑口被过滤
    expect(names).not.toEqual(
      expect.arrayContaining(['Vlan1', 'InLoop0', 'NULL0'])
    );
    // 共 5 个有效端口
    expect(ports).toHaveLength(5);
  });

  test('route 模式行：三层口无速率/无 VLAN，保留描述', () => {
    const ports = drv._parseBriefInterfaces(SAMPLE);
    const ge48 = ports.find(p => p.portName === 'GE1/0/48');

    expect(ge48).toMatchObject({
      portName: 'GE1/0/48',
      status: 'occupied',
      portSpeed: '1G', // route 段无 Speed 列 → 按端口名回填标称速率（GE → 1G）
      vlanId: null,
      description: 'uplink-to-core',
    });
  });

  test('bridge 模式行：解析速率/状态/PVID/描述', () => {
    const ports = drv._parseBriefInterfaces(SAMPLE);

    const fge = ports.find(p => p.portName === 'FGE1/0/53');
    expect(fge).toMatchObject({
      status: 'occupied',
      portSpeed: '40G',
      vlanId: 100,
      description: 'to-core',
      portType: 'QSFP+', // FGE → FortyGigE
    });

    const xge = ports.find(p => p.portName === 'XGE1/0/49');
    expect(xge).toMatchObject({
      status: 'free',
      portSpeed: '10G', // auto（无协商结果）→ 按端口名回填标称速率（XGE → 10G）
      vlanId: 1,
      description: null, // "--" → null
      portType: 'SFP+',
    });

    const ge1 = ports.find(p => p.portName === 'GE1/0/1');
    expect(ge1).toMatchObject({
      status: 'occupied',
      portSpeed: '1G',
      vlanId: 10,
      description: 'server-01',
      portType: 'RJ45',
    });
  });

  test('ADM（管理性关闭）映射为 free', () => {
    const ports = drv._parseBriefInterfaces(SAMPLE);
    const ge2 = ports.find(p => p.portName === 'GE1/0/2');
    expect(ge2.status).toBe('free');
    expect(ge2.description).toBe('reserved');
  });

  test('_mapLink 边界值', () => {
    expect(drv._mapLink('UP')).toBe('occupied');
    expect(drv._mapLink('DOWN')).toBe('free');
    expect(drv._mapLink('ADM')).toBe('free');
    expect(drv._mapLink('')).toBeNull();
    expect(drv._mapLink(null)).toBeNull();
  });

  test('空输入与非法输入返回空数组', () => {
    expect(drv._parseBriefInterfaces('')).toEqual([]);
    expect(drv._parseBriefInterfaces(null)).toEqual([]);
    expect(drv._parseBriefInterfaces(123)).toEqual([]);
  });

  test('mapper 新增 H3C 端口名缩写规则', () => {
    expect(inferPortType('HGE1/0/1')).toBe('QSFP28');
    expect(inferPortType('FGE1/0/53')).toBe('QSFP+');
    expect(inferPortType('TGE1/0/1')).toBe('SFP28');
    expect(inferPortType('M-GE0/0/0')).toBe('MGMT');
    expect(inferPortType('XGE1/0/49')).toBe('SFP+');
  });
});
