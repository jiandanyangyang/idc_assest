/**
 * 端口自动采集 - Telnet 驱动（原生 net.Socket，无第三方依赖）
 *
 * 设计说明：
 * - Telnet 是明文协议，端口 23，仅做只读命令采集，命令集与 SSH 驱动完全一致
 *   （display interface brief 等），解析逻辑直接借用华为/H3C SSH 驱动的实例方法
 *   （解析方法均为纯函数，不依赖连接状态）。
 * - 厂商自动探测：登录后执行 display version（华为/H3C），失败再试 show version
 *   （思科/锐捷），从输出识别 vendor；识别不出按华为系命令兜底（generic）。
 * - 会话逻辑（提示符识别、命令回显剥离、More 翻页兜底）与 BaseSSHDriver 保持一致。
 * - IAC 协商：拒绝所有 WILL/DO 选项（回应 DONT/WONT），丢弃子协商，
 *   避免设备等待协商结果；跨包截断的 IAC 序列通过 _iacTail 缓存处理。
 */
const net = require('net');
const logger = require('../../../utils/logger').module('PortDiscovery.Telnet');
const { detectVendorFromOutput } = require('../vendorDetect');
const { parsePortsFromTable } = require('../parser');
const { mapSpeed, mapStatus, inferPortType } = require('../mapper');
const HuaweiDriver = require('./huawei');
const H3CDriver = require('./h3c');

/** Telnet 协议字节常量（RFC 854） */
const IAC = 255;   // Interpret As Command
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;

/**
 * 从字节流中剥离 Telnet IAC 控制序列，返回可读文本与跨包残留
 * @param {Buffer} buf - 已拼接上次残留的完整字节流
 * @param {Function} onNegotiate - (cmd, option) => void，WILL/WONT/DO/DONT 回调
 * @returns {{ text: string, tail: Buffer }} tail 为不完整的 IAC 序列残留
 */
function stripTelnetIAC(buf, onNegotiate) {
  const out = [];
  let i = 0;
  const n = buf.length;
  const partial = () => ({ text: Buffer.from(out).toString('utf8'), tail: buf.slice(i) });

  while (i < n) {
    const b = buf[i];
    if (b !== IAC) {
      out.push(b);
      i += 1;
      continue;
    }
    if (i + 1 >= n) return partial(); // IAC 截断
    const cmd = buf[i + 1];
    if (cmd === IAC) { // 0xFF 转义为字面 0xFF
      out.push(IAC);
      i += 2;
      continue;
    }
    if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
      if (i + 2 >= n) return partial(); // 选项字节截断
      onNegotiate(cmd, buf[i + 2]);
      i += 3;
      continue;
    }
    if (cmd === 250) { // SB：子协商，丢弃到 IAC SE 为止
      let j = i + 2;
      while (j + 1 < n && !(buf[j] === IAC && buf[j + 1] === 240)) j += 1;
      if (j + 1 >= n) return partial(); // SE 未到达，等待后续包
      i = j + 2;
      continue;
    }
    // 其他命令：NOP(241)/GOAHEAD(249) 等双字节直接丢弃
    i += 2;
  }
  return { text: Buffer.from(out).toString('utf8'), tail: Buffer.alloc(0) };
}

/** 各厂商命令集与解析器（解析借用 SSH 驱动实例方法，均为纯函数） */
const VENDOR_SETS = {
  huawei: {
    versionCmd: 'display version',
    interfacesCmd: 'display interface brief',
    vlanCmd: 'display port vlan',
    parse(raw) {
      return parsePortsFromTable('huawei', raw, { mapSpeed, mapStatus, inferPortType })
        .filter(p => !/^NULLME/i.test(p.portName));
    },
    parseVlan(raw) {
      return new HuaweiDriver({})._parseVlanTable(raw);
    },
  },
  h3c: {
    versionCmd: 'display version',
    interfacesCmd: 'display interface brief',
    vlanCmd: null,
    parse(raw) {
      return new H3CDriver({})._parseBriefInterfaces(raw);
    },
    parseVlan: null,
  },
  // 思科（IOS / IOS-XE）：show interfaces status 为主，路由器无 switchport 时回退 show ip interface brief
  cisco: {
    versionCmd: 'show version',
    interfacesCmd: 'show interfaces status',
    briefCmd: 'show ip interface brief',
    vlanCmd: null,
    parse(raw) {
      return parsePortsFromTable('cisco', raw, { mapSpeed, mapStatus, inferPortType })
        .filter(p => !/^(Vlan|VLAN|Loop|LoopBack|Null|NULL|Tunnel|Async|Vif|Virtual)/i.test(p.portName));
    },
    parseVlan: null,
  },
  // 锐捷（RGOS）：与 Cisco IOS 高度一致
  ruijie: {
    versionCmd: 'show version',
    interfacesCmd: 'show interfaces status',
    briefCmd: 'show ip interface brief',
    vlanCmd: null,
    parse(raw) {
      return parsePortsFromTable('ruijie', raw, { mapSpeed, mapStatus, inferPortType })
        .filter(p => !/^(Vlan|VLAN|Loop|LoopBack|Null|NULL|Tunnel|Async|Vif|Virtual)/i.test(p.portName));
    },
    parseVlan: null,
  },
  // 兜底：厂商未识别时按华为系命令尝试
  generic: {
    versionCmd: 'display version',
    interfacesCmd: 'display interface brief',
    vlanCmd: null,
    parse(raw) {
      return parsePortsFromTable('huawei', raw, { mapSpeed, mapStatus, inferPortType })
        .filter(p => !/^NULLME/i.test(p.portName));
    },
    parseVlan: null,
  },
};

class BaseTelnetDriver {
  constructor(credential) {
    this.credential = credential; // DeviceCredential 实例（密码已解密）
    this.vendor = 'generic';
    this.socket = null;
    this.connected = false;
    this.prompt = null;      // 设备提示符（如 <hostname> / [hostname]）
    this._buf = '';          // 输出累积缓冲
    this._onData = null;     // 新数据到达回调
    this._iacTail = Buffer.alloc(0); // 跨包截断的 IAC 残留
    this.lastRawOutput = '';
    this.lastInterfacesOutput = '';
  }

  /**
   * 连接设备并完成 Telnet 登录、提示符识别、厂商探测
   * @returns {Promise<void>}
   * @throws {Error} 连接失败 / 登录失败 / 提示符无法识别时抛出
   */
  connect() {
    return new Promise((resolve, reject) => {
      const c = this.credential;
      if (!c.host) return reject(new Error('Telnet 凭据缺少 host，请检查凭据配置'));
      if (!c.username || !c.password) {
        return reject(new Error('Telnet 凭据缺少用户名或密码，请检查凭据配置'));
      }
      const port = c.port || 23;
      logger.info('Telnet 连接中', { host: c.host, port });

      const socket = net.createConnection({ host: c.host, port });
      this.socket = socket;
      this._buf = '';
      this._iacTail = Buffer.alloc(0);

      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        logger.error('Telnet 连接失败', { host: c.host, error: msg });
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(`Telnet 连接超时: ${c.host}:${port}`), 15000);

      socket.on('error', (err) => {
        clearTimeout(timer);
        fail(`Telnet 连接失败: ${err.message}`);
      });
      socket.on('close', () => {
        this.connected = false;
      });
      socket.on('data', (chunk) => {
        this._handleData(chunk);
        if (this._onData) this._onData();
      });
      socket.on('connect', () => {
        clearTimeout(timer);
        (async () => {
          try {
            await this._login();
            this.connected = true;
            logger.info('Telnet 登录成功', { host: c.host, prompt: this.prompt });
            await this._afterLogin();
            settled = true;
            resolve();
          } catch (e) {
            fail(e.message);
          }
        })();
      });
    });
  }

  /** 处理到达的数据：拼接残留、剥离 IAC（拒绝协商）、追加文本缓冲 */
  _handleData(chunk) {
    const buf = Buffer.concat([this._iacTail, chunk]);
    const { text, tail } = stripTelnetIAC(buf, (cmd, option) => {
      // 拒绝所有选项协商：WILL x → DONT x；DO x → WONT x
      if (cmd === WILL || cmd === DO) {
        const reply = Buffer.from([IAC, cmd === WILL ? DONT : WONT, option]);
        this._writeRaw(reply);
      }
    });
    this._iacTail = tail;
    this._buf += text;
  }

  /**
   * Telnet 登录：等 Username → 发用户名 → 等 Password → 发密码 → 等提示符
   */
  async _login() {
    // 1. 等待登录提示（部分设备先输出 banner）
    try {
      await this._waitFor(20000, (tail) => /(?:username|login)\s*:\s*$/i.test(tail.trimEnd()));
    } catch (e) {
      throw new Error(`未等到 Telnet 登录提示（设备可能不是 Telnet 服务或网络不通）: ${e.message}`);
    }
    this._writeLine(this.credential.username);

    // 2. 等待密码提示
    try {
      await this._waitFor(15000, (tail) => /password\s*:\s*$/i.test(tail.trimEnd()));
    } catch (e) {
      throw new Error(`未等到密码提示，请检查用户名是否正确: ${e.message}`);
    }
    this._writeLine(this.credential.password); // 密码由设备处理，通常不回显

    // 3. 等待登录后提示符（<host> 或 [host] 结尾）
    try {
      await this._waitFor(25000, (tail) => /[>\]]\s*$/.test(tail.trimEnd()));
    } catch (e) {
      const hint = this._buf.slice(-120).replace(/\s+/g, ' ').trim();
      throw new Error(`Telnet 登录超时，请检查用户名/密码是否正确（设备末尾输出: "${hint}"）`);
    }

    // 4. 识别提示符（与 BaseSSHDriver 相同规则：
    //    华为/H3C 的 <host> / [host]，以及思科/锐捷的 Hostname> / Hostname#）
    const lines = this._buf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    const m = lastLine.match(/(?:[<\[][\w.:-]+[>\]]|[\w.-]+[>#])$/);
    if (!m) {
      throw new Error(`Telnet 登录后未能识别设备提示符（输出末行: "${lastLine.slice(-60)}"）`);
    }
    this.prompt = m[0];
  }

  /**
   * 登录后初始化：关闭分页（两套命令都发，不匹配的设备报错但无害）+ 厂商探测
   */
  async _afterLogin() {
    // 关闭分页：华为/H3C 与 思科/Ruijie 命令不同，全部尝试，不匹配的设备报错但无害
    for (const cmd of ['screen-length 0 temporary', 'screen-length disable', 'terminal length 0']) {
      await this._send(cmd, 8000).catch(() => {});
    }

    // 探测厂商：display version（华为/H3C）→ show version（思科/锐捷）
    let verOut = '';
    for (const cmd of ['display version', 'show version']) {
      try {
        verOut = await this._send(cmd, 15000);
        if (verOut.trim()) break;
      } catch (_) { /* 换下一条 */ }
    }
    const detected = detectVendorFromOutput(verOut);
    this.vendor = detected && VENDOR_SETS[detected] ? detected : 'generic';
    logger.info('Telnet 厂商探测完成', { vendor: this.vendor, hasVersionOutput: !!verOut.trim() });
  }

  /**
   * 等待条件满足：有新数据到达时重新评估 condition（与 BaseSSHDriver 相同）
   * @param {number} timeoutMs
   * @param {Function} condition - (tailSinceWaitStart, wholeBuffer) => boolean
   */
  _waitFor(timeoutMs, condition) {
    return new Promise((resolve, reject) => {
      const start = this._buf.length;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._onData = null;
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('等待设备响应超时')), timeoutMs);
      const check = () => {
        if (settled) return;
        if (condition(this._buf.slice(start), this._buf)) finish();
        else this._onData = check;
      };
      check();
    });
  }

  /** 命令白名单（按探测到的厂商动态生成，禁止任意命令执行） */
  get allowedCommands() {
    const set = VENDOR_SETS[this.vendor] || VENDOR_SETS.generic;
    const list = [
      { name: 'version', cmd: set.versionCmd, description: '查看版本信息' },
      { name: 'interfaces', cmd: set.interfacesCmd, description: '查看所有接口状态' },
    ];
    if (set.vlanCmd) {
      list.push({ name: 'ports_vlan', cmd: set.vlanCmd, description: '查看端口 VLAN 信息' });
    }
    return list;
  }

  /**
   * 安全执行白名单内的命令
   * @param {string} cmdName - allowedCommands 中的 name
   * @returns {Promise<string>} 命令输出（不含命令回显与提示符）
   */
  exec(cmdName) {
    const cmdDef = this.allowedCommands.find(c => c.name === cmdName);
    if (!cmdDef) {
      return Promise.reject(new Error(`命令 "${cmdName}" 不在白名单中（vendor=${this.vendor}）`));
    }
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('Telnet 未连接，请先调用 connect()'));
    }
    logger.info('执行采集命令', { vendor: this.vendor, cmdName, cmd: cmdDef.cmd });
    return this._send(cmdDef.cmd, 30000);
  }

  /**
   * 发送一条命令并等待提示符返回（与 BaseSSHDriver._send 相同逻辑）
   * @param {string} cmd
   * @param {number} timeoutMs
   * @returns {Promise<string>} 命令输出
   */
  _send(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(new Error('Telnet 未连接，请先调用 connect()'));
      }
      const start = this._buf.length;
      let settled = false;
      let moreWrites = 0;

      const timer = setTimeout(() => {
        settled = true;
        this._onData = null;
        reject(new Error(`命令执行超时: ${cmd}`));
      }, timeoutMs);

      const check = () => {
        if (settled) return;
        const tail = this._buf.slice(start).replace(/\r/g, '');

        // 1) 分页提示：写空格翻页（兜底；正常情况下分页已在会话内关闭）
        if (/----\s*More\s*----\s*$/.test(tail)) {
          if (moreWrites > 500) {
            settled = true;
            clearTimeout(timer);
            this._onData = null;
            reject(new Error('分页交互次数过多，输出异常'));
            return;
          }
          moreWrites += 1;
          this._writeRaw(' ');
          return;
        }

        // 2) 提示符出现在尾部 → 命令执行完成
        if (this.prompt) {
          const escaped = String(this.prompt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(escaped + '\\s*$');
          if (re.test(tail.trimEnd())) {
            settled = true;
            clearTimeout(timer);
            this._onData = null;

            let out = tail;
            // 去掉首行命令回显
            const cmdEscaped = String(cmd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const echoRe = new RegExp('^[^\\n]*' + cmdEscaped + '[^\\n]*\\n');
            out = out.replace(echoRe, '');
            // 去掉尾部提示符
            const pIdx = out.lastIndexOf(this.prompt);
            if (pIdx >= 0) out = out.slice(0, pIdx);
            // 清理 More 分页残留
            out = out.replace(/----\s*More\s*----/g, '').replace(/^\n+/, '');

            this.lastRawOutput = out;
            logger.info('命令执行完成', { vendor: this.vendor, cmd, outputLength: out.length });
            resolve(out);
            return;
          }
        }

        this._onData = check;
      };

      this._writeLine(cmd);
      check();
    });
  }

  _writeRaw(data) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
  }

  /** 发送一行（Telnet NVT 标准 CR LF 行结束） */
  _writeLine(s) {
    this._writeRaw(s + '\r\n');
  }

  /**
   * 采集端口列表（复用对应厂商 SSH 驱动的解析逻辑）
   * @returns {Promise<Array<{ portName, portType, portSpeed, status, description, vlanId }>>}
   */
  async collectPorts() {
    const set = VENDOR_SETS[this.vendor] || VENDOR_SETS.generic;
    const out = await this.exec('interfaces');
    // 记录原始输出：采集失败时供路由层返回给前端诊断（与实际解析内容一致）
    this.lastInterfacesOutput = out;
    const ports = set.parse(out);

    // show interfaces status 无数据（如路由器无 switchport）时回退 show ip interface brief
    if (ports.length === 0 && set.briefCmd) {
      try {
        const briefOut = await this._send(set.briefCmd, 30000);
        const briefPorts = set.parse(briefOut);
        if (briefPorts.length > 0) {
          ports.length = 0;
          ports.push(...briefPorts);
          this.lastInterfacesOutput = briefOut;
        }
      } catch (_) { /* 回退失败，保留原结果 */ }
    }

    // VLAN 信息（华为系，可选，非致命）
    if (set.vlanCmd) {
      try {
        const vlanOut = await this.exec('ports_vlan');
        const vlanMap = set.parseVlan(vlanOut);
        for (const p of ports) {
          const v = vlanMap[p.portName];
          if (v !== undefined) p.vlanId = v;
        }
      } catch (_) { /* 部分固件不支持，忽略 */ }
    }

    return ports;
  }

  /**
   * 测试连通性（用于凭据测试）：登录成功 + 厂商探测完成即视为连通
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async test() {
    try {
      await this.connect();
      this.disconnect();
      return { ok: true, message: `Telnet 连通成功，厂商: ${this.vendor}，提示符: ${this.prompt}` };
    } catch (err) {
      this.disconnect();
      return { ok: false, message: err.message };
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.connected = false;
    if (this.socket) {
      // 先捕获局部引用并清空成员，setTimeout 回调才能按预期执行强制销毁
      const socket = this.socket;
      this.socket = null;
      try {
        socket.end();
        // 明文协议无优雅关闭保证，稍后强制销毁防止句柄泄漏
        setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, 500).unref();
      } catch (_) {
        // 连接可能已关闭，忽略
      }
    }
  }
}

/**
 * Telnet 驱动（协议分发入口，厂商由登录后探测决定）
 */
class TelnetDriver extends BaseTelnetDriver {
  constructor(credential) {
    super(credential);
    // vendor 初始值按凭据配置作为参考（探测失败时兜底由 generic 命令集处理）
    if (credential.vendor && VENDOR_SETS[credential.vendor]) {
      this.vendor = credential.vendor;
    }
  }
}

module.exports = TelnetDriver;
module.exports.stripTelnetIAC = stripTelnetIAC;
module.exports.VENDOR_SETS = VENDOR_SETS;
module.exports.BaseTelnetDriver = BaseTelnetDriver;
