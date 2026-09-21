/**
 * 端口自动采集 - 统一入口
 * 流程：凭据 → 连接 → 采集 → 解析 → 差异对比 → 返回预览
 * 调用后端批量接口落库由路由层完成（本文件只负责采集和 diff）
 */
const logger = require('../../utils/logger').module('PortDiscovery');
const Device = require('../../models/Device');
const DevicePort = require('../../models/DevicePort');
const { encrypt, decrypt } = require('../../utils/crypto');

const HuaweiDriver = require('./drivers/huawei');
const H3CDriver = require('./drivers/h3c');
const CiscoDriver = require('./drivers/cisco');
const RuijieDriver = require('./drivers/ruijie');
const SnmpDriver = require('./drivers/snmp');
const TelnetDriver = require('./drivers/telnet');
const { detectVendorFromOutput } = require('./vendorDetect');

/**
 * 驱动注册表
 */
const DRIVERS = {
  huawei: HuaweiDriver,
  h3c: H3CDriver,
  cisco: CiscoDriver,
  ruijie: RuijieDriver,
};

/**
 * 根据厂商标识创建驱动实例
 * @param {string} vendor
 * @param {Object} credential - DeviceCredential 模型实例（密码已解密）
 * @returns {BaseSSHDriver|SnmpDriver|TelnetDriver}
 */
function createDriver(vendor, credential) {
  // 协议级驱动与厂商无关：protocol 优先于 vendor 分发
  if (credential && credential.protocol === 'snmp') {
    return new SnmpDriver(credential);
  }
  if (credential && credential.protocol === 'telnet') {
    return new TelnetDriver(credential);
  }
  const Cls = DRIVERS[vendor];
  if (!Cls) {
    throw new Error(`暂不支持的厂商: ${vendor}`);
  }
  return new Cls(credential);
}

/**
 * 检测厂商（连接后执行 display version / show version 自动识别）
 * 降级策略：如果 credential.vendor 已配置，优先使用；否则自动探测
 * @param {Object} credential
 * @returns {Promise<string>} vendor key
 */
async function detectVendor(credential) {
  // Telnet：驱动在登录后自动探测厂商（display/show version），直接取结果
  if (credential.protocol === 'telnet') {
    const drv = createDriver('telnet', credential);
    try {
      await drv.connect();
      return drv.vendor || 'generic';
    } finally {
      drv.disconnect();
    }
  }
  // SNMP：从 sysDescr 识别厂商，识别失败返回 generic（不阻断采集，IF-MIB 本身厂商无关）
  if (credential.protocol === 'snmp') {
    const drv = createDriver('snmp', credential);
    try {
      await drv.connect();
      const out = await drv.exec('version');
      return detectVendorFromOutput(out) || 'generic';
    } catch (err) {
      logger.warn('SNMP 厂商识别失败', { error: err.message });
      return 'generic';
    } finally {
      drv.disconnect();
    }
  }
  // SSH：逐个尝试驱动直到成功
  for (const vendor of Object.keys(DRIVERS)) {
    const drv = createDriver(vendor, credential);
    try {
      await drv.connect();
      const out = await drv.exec('version');
      drv.disconnect();
      const detected = detectVendorFromOutput(out);
      if (detected && DRIVERS[detected]) return detected;
    } catch (_) {
      drv.disconnect();
    }
  }
  // 兜底返回 generic → 调用方需要显式指定 vendor
  throw new Error('无法自动识别设备厂商，请在凭据中手动指定 vendor');
}

/**
 * 从凭据对象中解密密文字段
 * 只解 SSH password / SNMP community / API token
 * @param {Object} cred - DeviceCredential 模型实例
 * @returns {Object} 解密后的凭据副本
 */
function decryptCredential(cred) {
  const decrypted = { ...cred.toJSON ? cred.toJSON() : cred };
  try { if (decrypted.password) decrypted.password = decrypt(decrypted.password); } catch (_) { decrypted.password = ''; }
  try { if (decrypted.community) decrypted.community = decrypt(decrypted.community); } catch (_) { decrypted.community = ''; }
  try { if (decrypted.apiToken) decrypted.apiToken = decrypt(decrypted.apiToken); } catch (_) { decrypted.apiToken = ''; }
  return decrypted;
}

/**
 * 对采集到的端口列表与数据库现有端口做差异对比
 * @param {string} deviceId
 * @param {Array} collected - 采集到的端口数组
 * @returns {Promise<{ added: Array, changed: Array, removed: Array, unchanged: Array }>}
 */
async function diffPorts(deviceId, collected) {
  const existing = await DevicePort.findAll({
    where: { deviceId },
  });

  const existingMap = new Map(); // portName → DevicePort 实例
  for (const p of existing) existingMap.set(p.portName, p);

  const result = { added: [], changed: [], removed: [], unchanged: [] };

  const collectedNames = new Set();
  for (const cp of collected) {
    collectedNames.add(cp.portName);
    const ep = existingMap.get(cp.portName);
    if (!ep) {
      // 新增：库中没有
      result.added.push(cp);
      continue;
    }
    // 变更检查：逐项对比关键字段
    const fieldChanges = {};
    const epJSON = ep.toJSON();
    const fields = ['portType', 'portSpeed', 'status', 'description', 'vlanId'];
    for (const f of fields) {
      if (cp[f] !== undefined && cp[f] !== null && cp[f] !== epJSON[f]) {
        fieldChanges[f] = { from: epJSON[f], to: cp[f] };
      }
    }
    if (Object.keys(fieldChanges).length > 0) {
      result.changed.push({ ...cp, fieldChanges, portId: ep.portId });
    } else {
      result.unchanged.push({ ...cp, portId: ep.portId });
    }
  }

  // 失效：库中有但采集不到的端口
  for (const ep of existing) {
    if (!collectedNames.has(ep.portName)) {
      result.removed.push(ep.toJSON());
    }
  }

  return result;
}

/**
 * 完整采集流程（统一入口）
 * @param {Object} credential - DeviceCredential 模型实例（已加密存储）
 * @param {Object} [opts]
 * @param {boolean} [opts.skipDiff=false] - 是否跳过差异对比（测试用）
 * @returns {Promise<{ vendor: string, ports: Array, diff: Object|null, rawOutput: string }>}
 */
async function discover(credential, opts = {}) {
  const decrypted = decryptCredential(credential);
  const isSnmp = decrypted.protocol === 'snmp';
  const isTelnet = decrypted.protocol === 'telnet';
  let vendor = decrypted.vendor;
  let driver;

  if (isSnmp || isTelnet) {
    // 协议级驱动（SNMP/Telnet）：与厂商无关，createDriver 按 protocol 分发。
    // Telnet 驱动在登录后自动探测厂商；SNMP 未配置厂商时连接后从 sysDescr 识别
    driver = createDriver(vendor, decrypted);
  } else if (!vendor) {
    vendor = await detectVendor(decrypted);
    driver = createDriver(vendor, decrypted);
  } else {
    if (!DRIVERS[vendor]) {
      throw new Error(`暂不支持的厂商: ${vendor}（当前支持: ${Object.keys(DRIVERS).join(' / ')}）`);
    }
    driver = createDriver(vendor, decrypted);

    // 显式配置的厂商可能配错（如把华为设备配成了 h3c），
    // 采集前先用 version 命令校验设备实际厂商，不一致时自动纠正
    try {
      await driver.connect();
      const ver = await driver.exec('version');
      driver.disconnect();
      const actual = detectVendorFromOutput(ver);
      if (actual && DRIVERS[actual] && actual !== vendor) {
        logger.warn('凭据厂商配置与设备实际厂商不符，已自动纠正', {
          deviceId: credential.deviceId,
          configured: vendor,
          actual,
        });
        vendor = actual;
        driver = createDriver(vendor, decrypted);
      }
    } catch (e) {
      driver.disconnect();
      // version 校验失败（如命令在设备上不被识别），回退完整自动探测
      logger.warn('厂商校验失败，回退自动探测', { configured: vendor, error: e.message });
      vendor = await detectVendor(decrypted);
      driver = createDriver(vendor, decrypted);
    }
  }
  let rawOutput = '';
  let ports = [];

  try {
    await driver.connect();
    if (isSnmp && !vendor) {
      // SNMP 未配置厂商：从 sysDescr 识别（仅展示用，失败不阻断采集）
      try {
        const out = await driver.exec('version');
        vendor = detectVendorFromOutput(out) || 'generic';
      } catch (_) {
        vendor = 'generic';
      }
    }
    if (isTelnet) {
      // Telnet 驱动登录后已自动探测厂商（比凭据配置更可靠），直接采用
      vendor = driver.vendor || vendor || 'generic';
    }
    ports = await driver.collectPorts();
    // 取驱动记录的 interfaces 命令原始输出（与实际解析内容一致）
    rawOutput = driver.lastInterfacesOutput || driver.lastRawOutput || '';
  } finally {
    driver.disconnect();
  }

  // 安全保护：解析出 0 个端口时大概率是命令执行失败或解析失败，
  // 绝不能进入 diff（否则库中已有端口会被全部判为"失效"）
  if (ports.length === 0) {
    const preview = (rawOutput || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    logger.error('端口采集解析结果为空', {
      deviceId: credential.deviceId,
      vendor,
      rawOutputLength: (rawOutput || '').length,
      rawOutput,
    });
    const err = new Error(
      `连接成功但未解析到任何端口（vendor=${vendor}）。` +
      `可能原因：命令输出格式与解析规则不匹配，或凭据的厂商配置与设备实际厂商不符。` +
      `设备返回内容片段: ${preview || '(空)'}。` +
      `请在弹窗中展开"原始输出"查看完整内容。`
    );
    // 把完整原始输出挂到错误上，由路由层返回给前端诊断
    err.rawOutput = rawOutput;
    err.vendor = vendor;
    throw err;
  }

  let diff = null;
  if (!opts.skipDiff) {
    // 设备 ID 来自 credential
    diff = await diffPorts(credential.deviceId, ports);
  }

  logger.info('端口采集完成', {
    deviceId: credential.deviceId,
    vendor,
    collectedCount: ports.length,
    added: diff?.added?.length || 0,
    changed: diff?.changed?.length || 0,
    removed: diff?.removed?.length || 0,
  });

  return { vendor, ports, diff, rawOutput };
}

module.exports = {
  discover,
  createDriver,
  detectVendor,
  detectVendorFromOutput,
  decryptCredential,
  diffPorts,
  DRIVERS,
};
