const {
  buildPortsFromSnmpTables,
  buildRawTableText,
} = require('../services/portDiscovery/snmpMapper');

/** 构造一份典型的交换机 IF-MIB 表数据（GE1/0/1-2 + XGE 上联 + Vlanif + Loopback） */
function makeTables() {
  return {
    ifName: { 1: 'GigabitEthernet0/0/1', 2: 'GigabitEthernet0/0/2', 3: 'XGigabitEthernet0/0/27', 4: 'Vlanif1', 5: 'LoopBack0', 6: 'NULL0' },
    ifDescr: { 1: 'GigabitEthernet0/0/1', 2: 'GigabitEthernet0/0/2', 3: 'XGigabitEthernet0/0/27', 4: 'Vlanif1', 5: 'LoopBack0', 6: 'NULL0' },
    ifType: { 1: 6, 2: 6, 3: 6, 4: 136, 5: 24, 6: 1 }, // 24=softwareLoopback, 1=other
    ifOperStatus: { 1: 1, 2: 2, 3: 1, 4: 1, 5: 1, 6: 2 }, // 1=up, 2=down
    ifAdminStatus: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }, // 1=up
    ifHighSpeed: { 1: 1000, 2: 0, 3: 10000, 4: 1000, 5: 0, 6: 0 },
    ifSpeed: { 1: 1000000000, 2: 1000000000, 3: 10000000000, 4: 1000000000, 5: 4294967295, 6: 4294967295 },
    ifAlias: { 1: 'to-server-01', 2: '', 3: 'uplink-core' },
  };
}

describe('snmpMapper.buildPortsFromSnmpTables', () => {
  it('按 ifName 生成端口并映射状态/速率/描述', () => {
    const ports = buildPortsFromSnmpTables(makeTables());
    const ge1 = ports.find(p => p.portName === 'GigabitEthernet0/0/1');
    const ge2 = ports.find(p => p.portName === 'GigabitEthernet0/0/2');
    const xge = ports.find(p => p.portName === 'XGigabitEthernet0/0/27');

    expect(ge1).toMatchObject({
      portType: 'RJ45',
      portSpeed: '1G',
      status: 'occupied',
      description: 'to-server-01',
    });
    // DOWN 口协商速率为 0 → 按端口名标称速率兜底
    expect(ge2).toMatchObject({ status: 'free', portSpeed: '1G' });
    expect(xge).toMatchObject({ portType: 'SFP+', portSpeed: '10G', status: 'occupied' });
  });

  it('保留 Vlanif 三层口、过滤 LoopBack（ifType=24）与 NULL 接口', () => {
    const ports = buildPortsFromSnmpTables(makeTables());
    const names = ports.map(p => p.portName);
    expect(names).toContain('Vlanif1');   // ifType 136 保留
    expect(names).not.toContain('LoopBack0'); // ifType 24 过滤
    expect(names).not.toContain('NULL0');     // ifType 1 + NULL 名过滤
  });

  it('admin down 映射为 free（管理关闭）', () => {
    const tables = makeTables();
    tables.ifAdminStatus[2] = 2; // GE1/0/2 管理关闭
    const ports = buildPortsFromSnmpTables(tables);
    expect(ports.find(p => p.portName === 'GigabitEthernet0/0/2').status).toBe('free');
  });

  it('ifHighSpeed 缺失时用 ifSpeed（bps）回退', () => {
    const tables = makeTables();
    delete tables.ifHighSpeed;
    const ports = buildPortsFromSnmpTables(tables);
    expect(ports.find(p => p.portName === 'GigabitEthernet0/0/1').portSpeed).toBe('1G');
    expect(ports.find(p => p.portName === 'XGigabitEthernet0/0/27').portSpeed).toBe('10G');
  });

  it('PVID 按 ifIndex 映射为 vlanId，缺失时不带 vlanId 字段值', () => {
    const tables = makeTables();
    const ports = buildPortsFromSnmpTables(tables, { 1: 100, 4: 1 });
    expect(ports.find(p => p.portName === 'GigabitEthernet0/0/1').vlanId).toBe(100);
    expect(ports.find(p => p.portName === 'Vlanif1').vlanId).toBe(1);
    expect(ports.find(p => p.portName === 'GigabitEthernet0/0/2').vlanId).toBeUndefined();
  });

  it('ifName 缺失时回退 ifDescr', () => {
    const tables = makeTables();
    const ifNameOnly = { ...tables, ifName: {} };
    const ports = buildPortsFromSnmpTables(ifNameOnly);
    expect(ports.map(p => p.portName)).toContain('GigabitEthernet0/0/1');
  });

  it('端口按名称自然排序（GE1/0/1 < GE1/0/10）', () => {
    const tables = {
      ifName: { 1: 'GE1/0/10', 2: 'GE1/0/2', 3: 'GE1/0/1' },
      ifDescr: {},
      ifType: { 1: 6, 2: 6, 3: 6 },
      ifOperStatus: { 1: 2, 2: 2, 3: 2 },
      ifAdminStatus: { 1: 1, 2: 1, 3: 1 },
    };
    const ports = buildPortsFromSnmpTables(tables);
    expect(ports.map(p => p.portName)).toEqual(['GE1/0/1', 'GE1/0/2', 'GE1/0/10']);
  });

  it('空表数据返回空数组（不抛异常）', () => {
    expect(buildPortsFromSnmpTables({})).toEqual([]);
    expect(buildPortsFromSnmpTables(null)).toEqual([]);
  });
});

describe('snmpMapper.buildRawTableText', () => {
  it('输出包含表头与端口行（诊断用）', () => {
    const text = buildRawTableText(makeTables());
    expect(text).toContain('ifIndex');
    expect(text).toContain('GigabitEthernet0/0/1');
    expect(text).toContain('to-server-01');
  });
});
