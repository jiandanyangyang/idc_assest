/**
 * 端口自动采集 - Cisco (IOS / IOS-XE / NX-OS 基础) 驱动
 * 命令与解析逻辑复用 IosLikeDriver（IOS / RGOS 系通用）。
 */
const IosLikeDriver = require('./iosLike');

class CiscoDriver extends IosLikeDriver {
  constructor(credential) {
    super(credential, 'cisco');
  }
}

module.exports = CiscoDriver;
