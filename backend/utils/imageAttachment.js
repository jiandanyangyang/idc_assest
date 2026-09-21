'use strict';

/**
 * 通用图片附件工具
 * 供设备(devices)、耗材(consumables)等实体复用，集中处理：
 * - 图片类型/大小校验
 * - 安全文件名生成与落盘（uploads/{entity}/）
 * - 旧图删除与目录穿越防护
 *
 * 依赖全局 express-fileupload 中间件（req.files），落盘使用 file.mv()。
 */

const fs = require('fs');
const path = require('path');
const { FILE_UPLOAD } = require('../config');
const logger = require('./logger').module('ImageAttachment');

// 允许的图片 MIME → 扩展名
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const ALLOWED_IMAGE_TYPES = FILE_UPLOAD.ALLOWED_IMAGE_TYPES;
const MAX_IMAGE_SIZE = FILE_UPLOAD.MAX_IMAGE_SIZE;

// uploads 根目录（backend/uploads）
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

/**
 * 清洗实体标识，仅保留小写字母/数字/下划线/短横线，防止路径穿越
 * @param {string} value
 * @returns {string}
 */
const safeSegment = value => String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

/**
 * 校验上传的图片文件
 * @param {Object} file - express-fileupload 文件对象
 * @returns {{ok: boolean, message?: string}}
 */
function validateImage(file) {
  if (!file) {
    return { ok: false, message: '请选择要上传的图片' };
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return { ok: false, message: '只支持 JPG、PNG、GIF 和 WebP 格式的图片' };
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return {
      ok: false,
      message: `图片大小不能超过 ${Math.round(MAX_IMAGE_SIZE / 1024 / 1024)}MB`,
    };
  }
  return { ok: true };
}

/**
 * 解析落盘扩展名：优先按 MIME，回退到原文件名，最后兜底 .jpg
 * @param {Object} file
 * @returns {string}
 */
function resolveExt(file) {
  if (EXT_BY_MIME[file.mimetype]) return EXT_BY_MIME[file.mimetype];
  const ext = path.extname(file.name || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
    return ext === '.jpeg' ? '.jpg' : ext;
  }
  return '.jpg';
}

/**
 * 保存图片到 uploads/{entity}/ 并返回图片元数据
 * @param {string} entity - 实体分类（如 devices / consumables），决定存储子目录
 * @param {string} entityId - 实体主键，用于生成可读文件名
 * @param {Object} file - express-fileupload 文件对象
 * @returns {Promise<{url: string, name: string, size: number, uploadedAt: string}>}
 */
async function saveImage(entity, entityId, file) {
  const dirName = safeSegment(entity);
  if (!dirName) {
    throw new Error('非法的图片分类');
  }

  const dir = path.join(UPLOADS_ROOT, dirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ext = resolveExt(file);
  const rand = Math.random().toString(36).slice(2, 8);
  const prefix = safeSegment(entityId) || 'item';
  const filename = `${prefix}_${Date.now()}_${rand}${ext}`;

  await file.mv(path.join(dir, filename));

  return {
    url: `/uploads/${dirName}/${filename}`,
    name: file.name || filename,
    size: file.size || 0,
    uploadedAt: new Date().toISOString(),
  };
}

/**
 * 删除磁盘上的图片文件（仅允许 uploads 目录内的相对 URL）
 * @param {string} url - 形如 /uploads/devices/xxx.jpg
 * @returns {boolean} 是否实际删除了文件
 */
function deleteImageFile(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) {
    return false;
  }
  const rel = url.replace(/^\/uploads\//, '');
  const target = path.resolve(UPLOADS_ROOT, rel);
  // 防目录穿越：目标必须位于 uploads 根目录之内
  if (!target.startsWith(path.resolve(UPLOADS_ROOT) + path.sep)) {
    return false;
  }
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return true;
    }
  } catch (err) {
    logger.warn('删除图片文件失败', { url, error: err.message });
  }
  return false;
}

/**
 * 批量删除图片文件（供实体删除时清理）
 * @param {Array<string|{url:string}>} images
 * @returns {number} 实际删除的文件数
 */
function deleteImages(images) {
  if (!Array.isArray(images)) return 0;
  return images.reduce((count, item) => {
    const url = typeof item === 'string' ? item : item?.url;
    return count + (deleteImageFile(url) ? 1 : 0);
  }, 0);
}

module.exports = {
  validateImage,
  saveImage,
  deleteImageFile,
  deleteImages,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_SIZE,
};
