const { DataTypes } = require('sequelize');
const {
  supportsColumnDefault,
  getTypeKey,
  serializeDefaultValue,
} = require('../utils/schemaUtils');

describe('schemaUtils 列默认值规则（MySQL 兼容）', () => {
  it('getTypeKey 能取到 Sequelize 类型键', () => {
    expect(getTypeKey(DataTypes.JSON)).toBe('JSON');
    expect(getTypeKey(DataTypes.TEXT)).toBe('TEXT');
    expect(getTypeKey(DataTypes.STRING)).toBe('STRING');
    expect(getTypeKey(DataTypes.INTEGER)).toBe('INTEGER');
    expect(getTypeKey(undefined)).toBe('');
  });

  it('JSON / TEXT / BLOB / GEOMETRY 不支持 DEFAULT', () => {
    ['JSON', 'TEXT', 'LONGTEXT', 'BLOB', 'GEOMETRY'].forEach(type => {
      expect(supportsColumnDefault(type)).toBe(false);
    });
  });

  it('字符串 / 数值 / 日期等类型支持 DEFAULT', () => {
    ['STRING', 'INTEGER', 'FLOAT', 'BOOLEAN', 'DATE', 'ENUM'].forEach(type => {
      expect(supportsColumnDefault(type)).toBe(true);
    });
  });

  it('类型未知时保守返回支持（不改变既有行为）', () => {
    expect(supportsColumnDefault('')).toBe(true);
    expect(supportsColumnDefault(undefined)).toBe(true);
  });

  it('serializeDefaultValue 将数组/对象序列化为 JSON 文本，字符串原样返回', () => {
    expect(serializeDefaultValue([])).toBe('[]');
    expect(serializeDefaultValue({})).toBe('{}');
    expect(serializeDefaultValue('个')).toBe('个');
    expect(serializeDefaultValue(0)).toBe('0');
    expect(serializeDefaultValue(undefined)).toBeUndefined();
  });
});
