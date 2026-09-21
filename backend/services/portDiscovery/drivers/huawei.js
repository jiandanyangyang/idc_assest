/**
 * 端口自动采集 - 华为驱动
 * 华为 display interface brief 输出格式：
 * Interface                   PHY   Protocol  InUti OutUti   inErrors  outErrors
 * GigabitEthernet0/0/1        up    up        0.01%  0.00%         0          0
 * GigabitEthernet0/0/2        down  down         0%     0%         0          0
 * ...
 * Vlanif1                     --    up         0.01%  0.00%         0          0
 * LoopBack0                   up    up(h)       0%     0%         0          0
 *
 * VLAN 信息来自 display port vlan（可选）：
 * Port                    Link Type    PVID     Trunk VLAN Passing
 * ----------------------------------------------------------------------
 * GigabitEthernet0/0/1    trunk         1        1 100 200
 * GigabitEthernet0/0/2    access        10       --
 */
const BaseSSHDriver = require('./base');
const { parsePortsFromTable } = require('../parser');
const { mapSpeed, mapStatus, inferPortType } = require('../mapper');

class HuaweiDriver extends BaseSSHDriver {
  constructor(credential) {
    super(credential);
    this.vendor = 'huawei';
    // 命令白名单（禁止任意命令执行）
    this.allowedCommands = [
      { name: 'version', cmd: 'display version', description: '查看版本信息' },
      { name: 'interfaces', cmd: 'display interface brief', description: '查看所有接口状态' },
      { name: 'ports_vlan', cmd: 'display port vlan', description: '查看端口 VLAN 信息' },
      { name: 'port_descriptions', cmd: 'display current-configuration interface', description: '查看接口描述' },
    ];
  }

  /**
   * VRP 关闭分页：进入交互式 shell 后由基类在同一会话内执行，
   * screen-length 0 temporary 仅当前会话生效——这正是 shell 模式的前提。
   */
  _getPaginatorDisable() { return 'screen-length 0 temporary'; }

  /**
   * 采集端口列表
   * @returns {Promise<Array<{ portName, portType, portSpeed, status, description, vlanId }>>}
   */
  async collectPorts() {
    const mapper = { mapSpeed, mapStatus, inferPortType };
    const out = await this.exec('interfaces');
    // 记录原始输出：采集失败时供路由层返回给前端诊断（与实际解析内容一致）
    this.lastInterfacesOutput = out;
    let ports = parsePortsFromTable(this.vendor, out, mapper);

    // 华为 display interface brief 不直接给速率和描述
    // 速率需从接口详细信息再抓一轮，或依赖端口名推断
    // VLAN 信息额外抓取 display port vlan
    try {
      const vlanOut = await this.exec('ports_vlan');
      const vlanMap = this._parseVlanTable(vlanOut);
      for (const p of ports) {
        const v = vlanMap[p.portName];
        if (v !== undefined) p.vlanId = v;
      }
    } catch (_) {
      // display port vlan 在部分固件版本上可能不可用，非致命
    }

    // 过滤掉三层虚拟接口（Vlanif / LoopBack / NULLME0 / Eth-Trunk 聚合口可保留）
    // 保留 Vlanif 方便三层口管理
    ports = ports.filter(p => !/^NULLME/i.test(p.portName));

    // 补充接口描述：display interface brief 不直接给描述，
    // 从 display current-configuration interface 解析每个接口下的 description 行
    try {
      const cfgOut = await this.exec('port_descriptions');
      const descMap = this._parseInterfaceDescriptions(cfgOut);
      for (const p of ports) {
        const d = descMap[p.portName];
        if (d) p.description = d;
      }
    } catch (_) {
      // 部分固件/版本不支持，忽略
    }

    return ports;
  }

  /**
   * 解析 display current-configuration interface 输出，得到 portName → description 映射
   * 输出形如：
   *   #
   *   interface GigabitEthernet0/0/1
   *    description Uplink to Core
   *    port link-type access
   * @param {string} raw
   * @returns {Object<string, string>}
   */
  _parseInterfaceDescriptions(raw) {
    if (!raw) return {};
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const map = {};
    let current = null;
    for (const line of lines) {
      const ifMatch = line.match(/^\s*interface\s+(\S+)/i);
      if (ifMatch) {
        current = ifMatch[1];
        continue;
      }
      if (/^\s*#/.test(line) || /^\s*(return|quit)\b/i.test(line)) {
        current = null; // 退出接口块
        continue;
      }
      if (current) {
        const descMatch = line.match(/^\s*description\s+(.+?)\s*$/i);
        if (descMatch) map[current] = descMatch[1];
      }
    }
    return map;
  }

  /**
   * 解析 display port vlan 输出
   * @param {string} raw
   * @returns {Object<string, number>} portName → PVID
   */
  _parseVlanTable(raw) {
    if (!raw) return {};
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const map = {};
    for (const line of lines) {
      // 跳过表头和分隔线
      if (/port|link\s*type/i.test(line) || /^-+$/.test(line)) continue;
      // 按空白切分：Port + Link Type + PVID + Trunk VLAN Passing
      // 真实 display port vlan 为定宽对齐，列间可能只有 1 空格，故用 \s+ 而非 \s{2,}
      const cols = line.split(/\s+/).map(s => s.trim());
      if (cols.length >= 3) {
        const portName = cols[0];
        const pvid = cols[2];
        if (/^\d+$/.test(pvid)) {
          map[portName] = parseInt(pvid, 10);
        }
      }
    }
    return map;
  }
}

module.exports = HuaweiDriver;
