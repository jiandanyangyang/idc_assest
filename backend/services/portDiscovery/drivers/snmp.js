/**
 * 端口自动采集 - SNMP 驱动（协议级，厂商无关）
 *
 * 为什么不按厂商拆分：
 * - SNMP 是标准协议，端口信息统一来自 IF-MIB（ifTable / ifXTable），
 *   华为 / 华三 / 思科 / 锐捷等厂商字段语义一致，无需 per-vendor 解析规则。
 * - vendor 仅用于展示与记录（从 sysDescr 识别），不影响采集逻辑。
 *
 * 仅支持 SNMPv2c（凭据模型中只有 community 字段）。
 * 只执行只读操作（GET / walk），不会修改设备配置。
 */
const snmp = require('net-snmp');
const logger = require('../../../utils/logger').module('PortDiscovery.SNMP');
const { buildPortsFromSnmpTables, buildRawTableText } = require('../snmpMapper');

/** 采集所需的 OID 清单（MIB-2 / IF-MIB / Q-BRIDGE-MIB） */
const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',       // 设备描述（厂商识别）
  sysName: '1.3.6.1.2.1.1.5.0',        // 设备主机名
  ifDescr: '1.3.6.1.2.1.2.2.1.2',      // 接口描述（ifName 回退）
  ifType: '1.3.6.1.2.1.2.2.1.3',       // 接口类型
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',      // 带宽 bps（32 位，高速率回退用）
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',// 管理状态
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8', // 运行状态
  ifName: '1.3.6.1.2.1.31.1.1.1.1',    // 接口名（ifXTable）
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15', // 带宽 Mbps（64 位安全）
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',  // 接口备注（description）
  dot1qPvid: '1.3.6.1.2.1.17.7.1.4.5.1.1', // Q-BRIDGE PVID（VLAN，可选）
};

/** 命令白名单（与 SSH 驱动接口对齐，exec() 只接受这些 name） */
const ALLOWED_COMMANDS = [
  { name: 'version', description: 'sysDescr / sysName（厂商识别）' },
  { name: 'interfaces', description: 'IF-MIB 接口表（端口采集）' },
];

class SnmpDriver {
  constructor(credential) {
    this.credential = credential; // DeviceCredential 实例（community 已解密）
    this.vendor = 'snmp';
    this.allowedCommands = ALLOWED_COMMANDS;
    this.session = null;
    this.connected = false;
    this.sysDescr = '';
    this.sysName = '';
    this._ports = null;            // collectPorts() 结果缓存
    this.lastRawOutput = '';       // 诊断用原始输出
    this.lastInterfacesOutput = '';// 最近一次接口表原始文本（路由层透出）
  }

  /**
   * 建立 SNMP 会话并验证可达性（GET sysDescr + sysName）
   * @returns {Promise<void>}
   * @throws {Error} 缺少 community / 超时 / Agent 无响应时抛出
   */
  connect() {
    return new Promise((resolve, reject) => {
      const c = this.credential;
      if (!c.community) {
        return reject(new Error('SNMP 凭据缺少 community，请检查凭据配置'));
      }
      if (!c.host) {
        return reject(new Error('SNMP 凭据缺少 host，请检查凭据配置'));
      }
      const port = c.port || 161;
      logger.info('SNMP 连接中', { host: c.host, port, version: '2c' });

      this.session = snmp.createSession(c.host, c.community, {
        port,
        retries: 1,
        timeout: 5000,
        version: snmp.Version2c,
      });

      this.session.get([OIDS.sysDescr, OIDS.sysName], (err, varbinds) => {
        if (err) {
          this.disconnect();
          logger.error('SNMP 连接失败', { host: c.host, error: err.message });
          return reject(new Error(`SNMP 连接失败: ${err.message}`));
        }
        for (const vb of varbinds || []) {
          const val = Buffer.isBuffer(vb.value) ? vb.value.toString() : String(vb.value);
          if (vb.oid === OIDS.sysDescr) this.sysDescr = val;
          if (vb.oid === OIDS.sysName) this.sysName = val;
        }
        this.connected = true;
        logger.info('SNMP 连接成功', { host: c.host, sysName: this.sysName });
        resolve();
      });
    });
  }

  /**
   * 执行白名单内的"命令"（SNMP 场景为读取对应 MIB 数据）
   * @param {string} cmdName - 'version' | 'interfaces'
   * @returns {Promise<string>} 文本输出（与 SSH 驱动返回形态对齐）
   * @throws {Error} 命令不在白名单、未连接时抛出
   */
  exec(cmdName) {
    const known = this.allowedCommands.find(c => c.name === cmdName);
    if (!known) {
      return Promise.reject(new Error(`命令 "${cmdName}" 不在白名单中（vendor=${this.vendor}）`));
    }
    if (!this.connected || !this.session) {
      return Promise.reject(new Error('SNMP 未连接，请先调用 connect()'));
    }
    if (cmdName === 'version') {
      return Promise.resolve([this.sysName, this.sysDescr].filter(Boolean).join('\n'));
    }
    if (cmdName === 'interfaces') {
      return this._fetchInterfaceTable();
    }
    return Promise.reject(new Error(`未实现的命令: ${cmdName}`));
  }

  /**
   * walk 一列 OID，返回 { [最后一段索引]: value }
   * @param {string} oid - 列 OID（如 ifName）
   * @returns {Promise<Object>}
   */
  _walkColumn(oid) {
    return new Promise((resolve, reject) => {
      const result = {};
      const base = `${oid}.`;
      const feedCb = (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          if (!vb.oid.startsWith(base)) continue;
          const idx = vb.oid.slice(base.length);
          // 只接受单段索引（ifTable 按行索引），多段索引（如 Q-BRIDGE 的 VLAN.N）跳过外层处理
          if (!/^\d+$/.test(idx)) continue;
          result[idx] = Buffer.isBuffer(vb.value) ? vb.value.toString() : vb.value;
        }
      };
      const doneCb = (err) => {
        if (err) return reject(new Error(`SNMP walk 失败 (${oid}): ${err.message}`));
        resolve(result);
      };
      this.session.subtree(oid, 25, feedCb, doneCb);
    });
  }

  /**
   * 抓取接口表并构建统一端口列表
   * @returns {Promise<string>} 原始表文本（诊断用）
   */
  async _fetchInterfaceTable() {
    const tables = {};
    // 核心列：任一失败即整体失败
    for (const key of ['ifName', 'ifDescr', 'ifType', 'ifOperStatus', 'ifAdminStatus', 'ifHighSpeed', 'ifSpeed', 'ifAlias']) {
      tables[key] = await this._walkColumn(OIDS[key]);
    }

    // PVID 为可选列：Q-BRIDGE MIB 在部分交换机上未启用，失败不致命
    let pvidByIfIndex = {};
    try {
      pvidByIfIndex = await this._walkColumn(OIDS.dot1qPvid);
    } catch (err) {
      logger.warn('Q-BRIDGE PVID 读取失败（非致命，VLAN 信息缺失）', { error: err.message });
    }

    this._ports = buildPortsFromSnmpTables(tables, pvidByIfIndex);
    this.lastInterfacesOutput = buildRawTableText(tables);
    this.lastRawOutput = this.lastInterfacesOutput;
    logger.info('SNMP 接口表抓取完成', {
      host: this.credential.host,
      ifIndexCount: Object.keys(tables.ifName).length,
      portCount: this._ports.length,
    });
    return this.lastInterfacesOutput;
  }

  /**
   * 采集端口列表
   * @returns {Promise<Array<{ portName, portType, portSpeed, status, description, vlanId }>>}
   */
  async collectPorts() {
    if (!this._ports) {
      await this._fetchInterfaceTable();
    }
    return this._ports;
  }

  /**
   * 测试连通性（用于凭据测试）
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async test() {
    try {
      await this.connect();
      this.disconnect();
      const desc = this.sysDescr ? `，设备: ${this.sysName || this.sysDescr.slice(0, 60)}` : '';
      return { ok: true, message: `SNMP 连通成功${desc}` };
    } catch (err) {
      this.disconnect();
      return { ok: false, message: err.message };
    }
  }

  /**
   * 关闭会话
   */
  disconnect() {
    this.connected = false;
    if (this.session) {
      try {
        this.session.close();
      } catch (_) {
        // 会话可能已关闭，忽略
      }
      this.session = null;
    }
  }
}

module.exports = SnmpDriver;
