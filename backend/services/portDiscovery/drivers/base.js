/**
 * 端口自动采集 - SSH 驱动基类（交互式 shell 会话模式）
 *
 * 为什么不用 exec 通道：
 * - Comware/VRP 的 SSH exec 通道一次只执行一条命令（不支持 && 串联），
 *   且每次 exec 是独立 CLI 会话，screen-length 设置无法跨会话生效，
 *   长输出会被 "---- More ----" 分页截断（物理端口表常在第二页之后）。
 * - 快速连续打开多个 exec 通道还可能被设备拒绝（Channel open failure）。
 *
 * 交互式 shell 模式：连接后打开一个 shell 通道，先在同一会话内执行
 * screen-length disable / screen-length 0 temporary 关闭分页，
 * 之后逐条发送命令、等待设备提示符返回，一次性拿到完整输出。
 */
const { Client } = require('ssh2');
const logger = require('../../../utils/logger').module('PortDiscovery.SSH');

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class BaseSSHDriver {
  constructor(credential) {
    this.credential = credential; // DeviceCredential 模型实例（密码已解密）
    this.vendor = 'generic';
    this.allowedCommands = []; // 子类填充
    this.client = null;
    this.connected = false;
    this.stream = null;      // 交互式 shell 流
    this.prompt = null;      // 设备提示符（如 <hostname> / [hostname]）
    this._buf = '';          // shell 输出累积缓冲
    this._onData = null;     // 新数据到达时的检查回调
    this.lastRawOutput = ''; // 最近一次命令的原始输出（诊断用）
  }

  /**
   * SSH 连接并初始化交互式 shell
   * @returns {Promise<void>}
   * @throws {Error} 连接失败或 shell 初始化失败时抛出（不静默兜底）
   */
  connect() {
    return new Promise((resolve, reject) => {
      const cfg = this._buildSSHConfig();
      logger.info('SSH 连接中', { host: cfg.host, port: cfg.port, username: cfg.username });

      this.client = new Client();
      this.client
        .on('ready', () => {
          this.connected = true;
          logger.info('SSH 连接成功', { host: cfg.host, port: cfg.port, username: cfg.username });
          this._initShell().then(resolve).catch((e) => {
            this.disconnect();
            reject(e);
          });
        })
        .on('error', (err) => {
          logger.error('SSH 连接失败', { host: cfg.host, error: err.message });
          reject(new Error(`SSH 连接失败: ${err.message}`));
        })
        .on('close', () => {
          this.connected = false;
          logger.info('SSH 连接关闭', { host: cfg.host });
        })
        .connect(cfg);
    });
  }

  /**
   * 构建 SSH 配置
   * @returns {Object} ssh2.Client config
   */
  _buildSSHConfig() {
    const c = this.credential;
    const port = c.port || 22;
    return {
      host: c.host,
      port,
      username: c.username || 'admin',
      password: c.password || '',
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      // 禁用严格 host key 检查（局域网管理场景可接受）
      algorithms: {
        kex: ['curve25519-sha256', 'ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256', 'diffie-hellman-group-exchange-sha256'],
      },
      tryKeyboard: true, // 支持 Password 认证（某些 SSH 配置只接受 keyboard-interactive）
    };
  }

  /**
   * 打开交互式 shell，等待初始提示符、识别提示符并关闭分页
   */
  _initShell() {
    return new Promise((resolve, reject) => {
      this.client.shell((err, stream) => {
        if (err) return reject(new Error(`打开 SSH shell 失败: ${err.message}`));
        this.stream = stream;
        this._buf = '';

        stream.on('data', (d) => {
          this._buf += d.toString();
          if (this._onData) this._onData();
        });
        stream.on('close', () => {
          this.connected = false;
        });

        (async () => {
          try {
            // 等待登录横幅之后的初始提示符（<host> / [host] 或 Cisco/Ruijie 的 Hostname> / Hostname#）
            await this._waitFor(20000, (tail) => /[>#\]]\s*$/.test(tail.trimEnd()));

            const lines = this._buf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const lastLine = lines[lines.length - 1] || '';
            // 华为 <host> / H3C [host]，以及 Cisco/Ruijie 的 Hostname> / Hostname#
            const m = lastLine.match(/(?:[<\[][\w.:-]+[>\]]|[\w.-]+[>#])$/);
            if (!m) {
              throw new Error(`未能识别设备提示符（输出末行: "${lastLine.slice(-60)}"）`);
            }
            this.prompt = m[0];
            logger.info('设备提示符识别成功', { vendor: this.vendor, prompt: this.prompt });

            // 在同一会话内关闭分页（子类定义命令；失败不致命，_send 自带 More 翻页兜底）
            const pagerCmd = this._getPaginatorDisable();
            if (pagerCmd) {
              await this._send(pagerCmd, 10000).catch((e) => {
                logger.warn('关闭分页命令执行失败（不致命）', { vendor: this.vendor, error: e.message });
              });
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        })();
      });
    });
  }

  /**
   * 等待条件满足：有新数据到达时重新评估 condition
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

  /**
   * 安全执行白名单内的命令（交互式 shell）
   * @param {string} cmdName - allowedCommands 中的 name
   * @returns {Promise<string>} 命令输出（不含命令回显与提示符）
   * @throws {Error} 命令不在白名单、未连接或执行失败时抛出
   */
  exec(cmdName) {
    const cmdDef = this.allowedCommands.find(c => c.name === cmdName);
    if (!cmdDef) {
      return Promise.reject(new Error(`命令 "${cmdName}" 不在白名单中（vendor=${this.vendor}）`));
    }
    if (!this.connected || !this.stream) {
      return Promise.reject(new Error('SSH 未连接，请先调用 connect()'));
    }
    logger.info('执行采集命令', { vendor: this.vendor, cmdName, cmd: cmdDef.cmd });
    return this._send(cmdDef.cmd, 30000);
  }

  /**
   * 在交互式 shell 中发送一条命令并等待提示符返回
   * @param {string} cmd - 完整命令字符串
   * @param {number} timeoutMs - 超时毫秒数
   * @returns {Promise<string>} 命令输出
   */
  _send(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.stream) {
        return reject(new Error('SSH 未连接，请先调用 connect()'));
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

        // 1) 分页提示：写空格翻页（兜底；正常情况下分页已在会话内被关闭）
        if (/----\s*More\s*----\s*$/.test(tail)) {
          if (moreWrites > 500) {
            settled = true;
            clearTimeout(timer);
            this._onData = null;
            reject(new Error('分页交互次数过多，输出异常'));
            return;
          }
          moreWrites += 1;
          this.stream.write(' ');
          return;
        }

        // 2) 提示符出现在尾部 → 命令执行完成
        if (this.prompt) {
          const re = new RegExp(escapeRegExp(this.prompt) + '\\s*$');
          if (re.test(tail.trimEnd())) {
            settled = true;
            clearTimeout(timer);
            this._onData = null;

            let out = tail;
            // 去掉首行命令回显（<host>cmd）
            const echoRe = new RegExp('^[^\\n]*' + escapeRegExp(cmd) + '[^\\n]*\\n');
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

      this.stream.write(cmd + '\n');
      check();
    });
  }

  /**
   * 子类重写：进入 shell 后执行的关闭分页命令（同一会话内生效）
   * 返回 null 表示不执行
   */
  _getPaginatorDisable() { return null; }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.client && this.connected) {
      try {
        if (this.stream) this.stream.end();
      } catch (_) {
        // 流可能已关闭，忽略
      }
      try {
        this.client.end();
      } catch (_) {
        // 连接可能已关闭，忽略
      }
    }
    this.connected = false;
  }

  /**
   * 测试连通性（用于凭据测试）
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async test() {
    try {
      await this.connect();
      const out = await this.exec('version');
      this.disconnect();
      return { ok: true, message: `连通成功，版本信息: ${String(out).slice(0, 100)}...` };
    } catch (err) {
      this.disconnect();
      return { ok: false, message: err.message };
    }
  }

  /**
   * 采集端口列表（子类重写）
   * @returns {Promise<Array>} 统一结构的端口数组
   */
  async collectPorts() {
    throw new Error('子类必须重写 collectPorts()');
  }
}

module.exports = BaseSSHDriver;
