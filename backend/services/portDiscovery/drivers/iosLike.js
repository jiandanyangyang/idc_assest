/**
 * 端口自动采集 - Cisco / Ruijie 共享驱动（IOS / RGOS 系）
 *
 * 命令均来自官方/权威资料核实（非臆测）：
 * - 关闭分页：terminal length 0（当前会话生效；只读 show 在用户模式亦可执行，
 *   即便部分设备在用户模式拒绝该命令，基类 _send 的 More 翻页兜底仍能保证完整输出）
 * - 主采集：show interfaces status
 *     Cisco 输出：Port Name Status Vlan Duplex Speed Type
 *     Ruijie 输出：Interface Status Vlan Duplex Speed Type（Status 为 up/down/err-disabled）
 * - 回退（路由器无 switchport 时 show interfaces status 无数据）：show ip interface brief
 *     输出：Interface IP-Address OK? Method Status Protocol
 * - 描述补充：show interfaces description
 *     输出：Interface Status Protocol Description
 *
 * 思科/Ruijie 提示符形如 Hostname> / Hostname#，由基类 _initShell 统一识别
 * （已在 base.js 放宽正则支持 # 与 >）。
 */
const BaseSSHDriver = require('./base');
const { parsePortsFromTable } = require('../parser');
const { mapSpeed, mapStatus, inferPortType } = require('../mapper');

/** 纯逻辑/虚拟接口，不作为物理端口采集（保留 Port-channel / AggregatePort 聚合口） */
const LOGICAL_IF_RE = /^(Vlan|VLAN|Loop|LoopBack|Null|NULL|Tunnel|Async|Vif|Virtual)/i;

class IosLikeDriver extends BaseSSHDriver {
  /**
   * @param {Object} credential - DeviceCredential 实例（密码已解密）
   * @param {string} vendor - 'cisco' | 'ruijie'
   */
  constructor(credential, vendor) {
    super(credential);
    this.vendor = vendor;
    // 命令白名单（禁止任意命令执行）
    this.allowedCommands = [
      { name: 'version', cmd: 'show version', description: '查看版本信息' },
      { name: 'interfaces', cmd: 'show interfaces status', description: '查看所有接口状态/速率/VLAN' },
      { name: 'interfaces_brief', cmd: 'show ip interface brief', description: '查看接口 IP 与状态（路由器/回退）' },
      { name: 'port_descriptions', cmd: 'show interfaces description', description: '查看接口描述' },
    ];
  }

  /**
   * IOS/RGOS 关闭分页：进入交互式 shell 后由基类在同一会话内执行，
   * terminal length 0 仅当前会话生效——这正是 shell 模式的前提。
   */
  _getPaginatorDisable() { return 'terminal length 0'; }

  /**
   * 采集端口列表
   * @returns {Promise<Array<{ portName, portType, portSpeed, status, description, vlanId }>>}
   */
  async collectPorts() {
    const mapper = { mapSpeed, mapStatus, inferPortType };
    let out = await this.exec('interfaces');
    // 记录原始输出：采集失败时供路由层返回给前端诊断（与实际解析内容一致）
    this.lastInterfacesOutput = out;
    let ports = parsePortsFromTable(this.vendor, out, mapper);

    // 交换机 show interfaces status 无数据（如路由器无 switchport）时回退 show ip interface brief
    if (ports.length === 0) {
      const brief = await this.exec('interfaces_brief');
      ports = parsePortsFromTable(this.vendor, brief, mapper);
      this.lastInterfacesOutput = brief;
    }

    // 补充描述（show interfaces description，部分版本可能不支持，非致命）
    try {
      const descOut = await this.exec('port_descriptions');
      const descMap = this._parseDescriptions(descOut);
      for (const p of ports) {
        const d = descMap[p.portName];
        if (d) p.description = d;
      }
    } catch (_) {
      // 部分固件/版本不支持 show interfaces description，忽略
    }

    // 过滤掉三层虚拟接口（Vlan / LoopBack / Null / Tunnel / Async / Vif / Virtual）
    return ports.filter(p => !LOGICAL_IF_RE.test(p.portName));
  }

  /**
   * 解析 show interfaces description 输出，得到 portName → description 映射
   * @param {string} raw
   * @returns {Object<string, string>}
   */
  _parseDescriptions(raw) {
    if (!raw) return {};
    const rows = parsePortsFromTable(this.vendor, raw, { mapSpeed, mapStatus, inferPortType });
    const map = {};
    for (const r of rows) {
      if (r.description) map[r.portName] = r.description;
    }
    return map;
  }
}

module.exports = IosLikeDriver;
