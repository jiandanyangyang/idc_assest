/**
 * 端口自动采集 - 厂商标识（SSH / Telnet 共用）
 * 从 version 命令输出判断设备实际厂商
 */

/**
 * 从 version 命令输出判断设备实际厂商
 * @param {string} out - display version / show version 输出
 * @returns {string|null} vendor key，无法识别时返回 null
 */
function detectVendorFromOutput(out) {
  if (!out) return null;
  // 注意先判 H3C：Comware 输出特征更具体
  if (/comware|h3c/i.test(out)) return 'h3c';
  if (/huawei|vrp/i.test(out)) return 'huawei';
  if (/cisco|nx-os|ios version/i.test(out)) return 'cisco';
  if (/ruijie/i.test(out)) return 'ruijie';
  return null;
}

module.exports = { detectVendorFromOutput };
