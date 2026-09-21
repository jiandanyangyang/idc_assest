'use strict';

/**
 * 表结构同步相关的纯函数工具
 *
 * 核心规则：MySQL 不支持 BLOB/TEXT/GEOMETRY/JSON 列使用字面量 DEFAULT
 * （手写 DDL 会报 1101）。Sequelize 生成 ADD COLUMN 时会自动忽略这类默认值，
 * 因此新增列对历史行只能取 NULL，必须在新增后按模型默认值回填，
 * 否则历史行与模型默认值（如 images 的 []）不一致。
 */

// MySQL 中不支持 DEFAULT 的列类型（Sequelize DataTypes.key 均为大写）
const NO_DEFAULT_COLUMN_TYPES = [
  'JSON',
  'TEXT',
  'TINYTEXT',
  'MEDIUMTEXT',
  'LONGTEXT',
  'BLOB',
  'TINYBLOB',
  'MEDIUMBLOB',
  'LONGBLOB',
  'GEOMETRY',
];

/**
 * 取 Sequelize 类型实例的类型键（如 DataTypes.JSON → 'JSON'）
 * @param {*} attrType - 模型属性的 type 值
 * @returns {string} 大写类型键；无法识别时返回空串
 */
function getTypeKey(attrType) {
  if (attrType && attrType.key) {
    return String(attrType.key).toUpperCase();
  }
  return '';
}

/**
 * 判断某列类型是否支持 DEFAULT 值
 * @param {string} typeKey - 类型键（如 'JSON' / 'STRING'）
 * @returns {boolean} 支持返回 true；不支持（须省略默认值）返回 false
 */
function supportsColumnDefault(typeKey) {
  if (!typeKey) {
    return true;
  }
  return !NO_DEFAULT_COLUMN_TYPES.includes(String(typeKey).toUpperCase());
}

/**
 * 将模型默认值序列化为可回填到无默认值列的字符串
 * @param {*} defaultValue
 * @returns {string|undefined}
 */
function serializeDefaultValue(defaultValue) {
  if (defaultValue === undefined) {
    return undefined;
  }
  return typeof defaultValue === 'string' ? defaultValue : JSON.stringify(defaultValue);
}

module.exports = {
  NO_DEFAULT_COLUMN_TYPES,
  getTypeKey,
  supportsColumnDefault,
  serializeDefaultValue,
};
