/**
 * 标称速率推断（inferNominalSpeed）测试
 * 背景：display interface brief 的 Speed 列是链路协商结果，端口 DOWN 时设备
 * 显示 auto/-- 拿不到速率，此时按端口名推断"接口规格"兜底回填。
 * 测试数据来源：咪咕 H3C S6520 真实端口名 + 华为命名体系。
 */
const { inferNominalSpeed } = require('../services/portDiscovery/mapper');
const H3CDriver = require('../services/portDiscovery/drivers/h3c');

describe('inferNominalSpeed 按端口名推断标称速率', () => {
  test('H3C 缩写体系（S6520 实测端口名）', () => {
    expect(inferNominalSpeed('XGE1/0/9')).toBe('10G');
    expect(inferNominalSpeed('XGE1/0/48')).toBe('10G');
    expect(inferNominalSpeed('FGE1/0/49')).toBe('40G');
    expect(inferNominalSpeed('FGE1/0/50')).toBe('40G');
    expect(inferNominalSpeed('MGE0/0/0')).toBe('1G');
    expect(inferNominalSpeed('GE1/0/1')).toBe('1G');
    expect(inferNominalSpeed('TGE1/0/1')).toBe('25G');
    expect(inferNominalSpeed('HGE1/0/1')).toBe('100G');
  });

  test('华为命名体系（全称 / 40GE / 100GE）', () => {
    expect(inferNominalSpeed('GigabitEthernet0/0/1')).toBe('1G');
    expect(inferNominalSpeed('XGigabitEthernet0/0/1')).toBe('10G');
    expect(inferNominalSpeed('40GE0/0/1')).toBe('40G');
    expect(inferNominalSpeed('100GE0/0/1')).toBe('100G');
  });

  test('40G 拆分口（XGE1/0/49:1）仍推断 10G', () => {
    expect(inferNominalSpeed('XGE1/0/49:1')).toBe('10G');
  });

  test('聚合口 / 三层逻辑口不推断（返回 null）', () => {
    expect(inferNominalSpeed('RAGG10')).toBeNull();
    expect(inferNominalSpeed('BAGG100')).toBeNull();
    expect(inferNominalSpeed('Bridge-Aggregation1')).toBeNull();
    expect(inferNominalSpeed('Route-Aggregation1')).toBeNull();
    expect(inferNominalSpeed('Eth-Trunk1')).toBeNull();
    expect(inferNominalSpeed('Vlan1')).toBeNull();
    expect(inferNominalSpeed('Vlan-interface1')).toBeNull();
    expect(inferNominalSpeed('LoopBack0')).toBeNull();
    expect(inferNominalSpeed('NULL0')).toBeNull();
  });

  test('非法输入返回 null', () => {
    expect(inferNominalSpeed('')).toBeNull();
    expect(inferNominalSpeed(null)).toBeNull();
    expect(inferNominalSpeed(undefined)).toBeNull();
  });
});

describe('H3C 解析行速率兜底（协商速率优先，标称兜底）', () => {
  const drv = new H3CDriver({});

  test('UP 口协商速率优先（10G(a) → 10G，不受标称影响）', () => {
    const raw = [
      'Brief information on interfaces in bridge mode:',
      'Interface            Link Speed   Duplex Type PVID Description',
      'XGE1/0/1             UP   10G(a)  Full   A    100  --',
    ].join('\n');
    const ports = drv._parseBriefInterfaces(raw);
    expect(ports).toHaveLength(1);
    expect(ports[0].portSpeed).toBe('10G');
  });

  test('DOWN 口 Speed=auto → 按端口名回填标称 10G', () => {
    const raw = [
      'Brief information on interfaces in bridge mode:',
      'Interface            Link Speed   Duplex Type PVID Description',
      'XGE1/0/9             DOWN auto    Auto   A    1    --',
    ].join('\n');
    const ports = drv._parseBriefInterfaces(raw);
    expect(ports).toHaveLength(1);
    expect(ports[0].portSpeed).toBe('10G');
  });

  test('FGE UP 口若显示 auto → 回填标称 40G', () => {
    const raw = [
      'Brief information on interfaces in bridge mode:',
      'Interface            Link Speed   Duplex Type PVID Description',
      'FGE1/0/49            UP   auto    Full   --   --   uplink',
    ].join('\n');
    const ports = drv._parseBriefInterfaces(raw);
    expect(ports).toHaveLength(1);
    expect(ports[0].portSpeed).toBe('40G');
  });

  test('聚合口 Speed=auto → 不回填（保持 null）', () => {
    const raw = [
      'Brief information on interfaces in bridge mode:',
      'Interface            Link Speed   Duplex Type PVID Description',
      'BAGG100              DOWN auto    --     --   1    --',
    ].join('\n');
    const ports = drv._parseBriefInterfaces(raw);
    expect(ports).toHaveLength(1);
    expect(ports[0].portSpeed).toBeNull();
  });
});
