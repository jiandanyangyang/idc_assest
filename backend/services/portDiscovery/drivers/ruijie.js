/**
 * 端口自动采集 - 锐捷 (RGOS) 驱动
 * RGOS 与 Cisco IOS 高度一致，命令与解析逻辑复用 IosLikeDriver。
 * 差异点（如聚合口名为 AggregatePort 而非 Port-channel）由通用解析/过滤规则自然兼容。
 */
const IosLikeDriver = require('./iosLike');

class RuijieDriver extends IosLikeDriver {
  constructor(credential) {
    super(credential, 'ruijie');
  }
}

module.exports = RuijieDriver;
