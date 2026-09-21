/**
 * 端口自动采集 - H3C (Comware) 驱动
 *
 * H3C Comware 7 的 `display interface brief` 输出分为 route / bridge 两段表格：
 *
 * Brief information on interfaces in route mode:
 * Link: ADM - administratively down; St(s) - state
 * Interface                Link Protocol Primary IP      Description
 * GE1/0/48                 UP   UP       192.168.56.10   uplink-to-core
 * Vlan1                    UP   UP       --              --
 * NULL0                    UP   UP(s)    --              --
 *
 * Brief information on interfaces in bridge mode:
 * Link: ADM - administratively down; St(s) - state
 * Speed: (a) - auto
 * Duplex: (a) - auto; (A) - auto; (H) - half
 * Type: A - access; T - trunk; H - hybrid
 * Interface                Link Speed   Duplex Type PVID Description
 * FGE1/0/53                UP   40G(a)  Full   T    100  to-core
 * GE1/0/1                  UP   1G(a)   Full   A    10   server-01
 *
 * 说明：
 * - Link 列：UP / DOWN / ADM（ADM 为管理性关闭）
 * - Speed 列带 "(a)" 后缀表示自协商，如 "1G(a)"、"40G(a)" 或 "auto"
 * - Type 列（A/T/H）是 VLAN 接口类型而非物理端口类型，物理类型靠端口名推断
 * - 两段表格均为固定宽度对齐，按列起始位置切分比按连续空白切分更可靠
 */
const BaseSSHDriver = require('./base');
const { mapSpeed, inferPortType, inferNominalSpeed } = require('../mapper');

/** 纯逻辑/虚拟接口，不作为物理端口采集（M-GE 为物理管理口，保留） */
const LOGICAL_IF_RE = /^(NULL|InLoop|LoopBack|Vlan|REG|Register|Tunnel|Route-Agg|BE-Board|Crypt|SSL|Dialer)/i;

class H3CDriver extends BaseSSHDriver {
  constructor(credential) {
    super(credential);
    this.vendor = 'h3c';
    // 命令白名单（禁止任意命令执行）
    this.allowedCommands = [
      { name: 'version', cmd: 'display version', description: '查看版本信息' },
      { name: 'interfaces', cmd: 'display interface brief', description: '查看所有接口概要' },
    ];
  }

  /**
   * Comware 关闭分页：进入交互式 shell 后由基类在同一会话内执行，
   * screen-length disable 仅当前会话生效——这正是 shell 模式的前提。
   */
  _getPaginatorDisable() { return 'screen-length disable'; }

  /**
   * 采集端口列表
   * @returns {Promise<Array<{ portName, portType, portSpeed, status, description, vlanId }>>}
   */
  async collectPorts() {
    const out = await this.exec('interfaces');
    // 记录原始输出：采集失败时供路由层返回给前端诊断（与实际解析内容一致）
    this.lastInterfacesOutput = out;
    return this._parseBriefInterfaces(out);
  }

  /**
   * 解析 display interface brief 输出（route + bridge 两段）
   * 兼容 Comware 5 / 7 的表头差异（Primary IP / Main IP）与段落标题差异
   * @param {string} raw - CLI 原始输出
   * @returns {Array<{ portName, portType, portSpeed, status, description, vlanId }>}
   */
  _parseBriefInterfaces(raw) {
    if (!raw || typeof raw !== 'string') return [];

    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const ports = [];
    let header = null; // 当前表头 { names: string[], starts: number[] }

    for (const rawLine of lines) {
      const line = rawLine.replace(/----\s*More\s*----/g, '').replace(/\s+$/, '');
      const trimmed = line.trim();

      // 空行 / 段落标题 / 图例行 → 结束当前表
      // 兼容 Comware 5 的 "The brief information of interface(s) under route mode:"
      if (
        !trimmed ||
        /^The?\s*brief information/i.test(trimmed) ||
        /^Brief information/i.test(trimmed) ||
        /^(Link|Speed|Duplex|Type|PVID):/i.test(trimmed)
      ) {
        header = null;
        continue;
      }

      // 表头行：以 "Interface" 开头，且包含 Link / Speed / Protocol 之类的列名
      if (/^Interface\b/.test(trimmed) && /\b(Link|Speed|Protocol)\b/i.test(trimmed)) {
        header = this._parseTableHeader(line);
        continue;
      }

      if (!header) continue;

      const port = this._parsePortRow(line, header);
      if (port) ports.push(port);
    }

    return ports;
  }

  /** 表头行中可能出现的列名（按输出顺序无关，按位置定位） */
  _parseTableHeader(line) {
    const CANDIDATES = [
      'Interface', 'Link', 'Protocol', 'Primary IP', 'Main IP',
      'Speed', 'Duplex', 'Type', 'PVID', 'Description',
    ];
    const found = [];
    for (const name of CANDIDATES) {
      const idx = line.indexOf(name);
      if (idx >= 0) found.push({ name, idx });
    }
    found.sort((a, b) => a.idx - b.idx);
    return {
      names: found.map(f => f.name),
      starts: found.map(f => f.idx),
    };
  }

  /**
   * 按列起始位置切分一行（Comware 表格固定宽度对齐，比按空白切分更稳）
   * @param {string} line
   * @param {number[]} starts - 各列起始位置（升序）
   * @returns {string[]}
   */
  _splitByPositions(line, starts) {
    const parts = [];
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : line.length;
      parts.push(line.slice(start, end).trim());
    }
    return parts;
  }

  /**
   * 解析一条数据行为端口对象
   * @param {string} line
   * @param {{ names: string[], starts: number[] }} header
   * @returns {Object|null}
   */
  _parsePortRow(line, header) {
    let cols = this._splitByPositions(line, header.starts);
    let cell = {};
    header.names.forEach((name, i) => { cell[name] = (cols[i] || '').trim(); });

    let portName = cell['Interface'];

    // 回退策略：设备实际列对齐可能与表头不一致（宽度差异/描述超长），
    // 导致按位置切出的接口名混入后续列内容（含空格）或为空。
    // 此时退回"按连续空白切分"，第一列即接口名。
    if (!portName || /\s/.test(portName)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        cols = parts;
        portName = parts[0];
        // 重新按空白列填充（仅当列数匹配时才可信，否则仅保底取接口名与 Link）
        cell = {};
        header.names.forEach((name, i) => { cell[name] = (cols[i] || '').trim(); });
        if (/\s/.test(portName)) return null; // 仍含空格说明这行不是数据行
      } else {
        return null;
      }
    }

    if (!portName) return null;
    // 过滤纯逻辑接口
    if (LOGICAL_IF_RE.test(portName)) return null;

    const speedRaw = cell['Speed'];
    const pvid = cell['PVID'];
    const desc = cell['Description'];

    // 速率：协商速率优先（如 10G(a)）；DOWN 口设备显示 auto/--，按端口名回填标称速率
    const negotiatedSpeed = speedRaw ? mapSpeed(String(speedRaw).replace(/\(a\)/gi, '')) : null;

    return {
      portName,
      portType: inferPortType(portName),
      portSpeed: negotiatedSpeed || inferNominalSpeed(portName),
      status: this._mapLink(cell['Link']),
      description: !desc || desc === '--' ? null : desc,
      vlanId: pvid && /^\d+$/.test(pvid) ? parseInt(pvid, 10) : null,
    };
  }

  /**
   * H3C Link 列值 → 系统标准状态
   * UP → occupied；DOWN / ADM（管理性关闭）→ free
   * @param {string} raw
   * @returns {string|null}
   */
  _mapLink(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/\(.*\)/, '').toUpperCase();
    if (s === 'UP') return 'occupied';
    if (s === 'DOWN' || s === 'ADM' || s === 'ADMDOWN') return 'free';
    return null;
  }
}

module.exports = H3CDriver;
