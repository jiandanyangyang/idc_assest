'use strict';

/**
 * 通用图片附件路由
 * POST   /api/images  上传图片（multipart：entity + id + image）
 * DELETE /api/images  删除图片（JSON：entity + id + url）
 *
 * 按 entity 分发到对应实体，图片以 JSON 数组形式存于实体的 images 列。
 * 权限按实体维度校验（设备：device:create/device:edit；耗材：consumable:create/consumable:edit）。
 */

const express = require('express');
const router = express.Router();
const Device = require('../models/Device');
const Consumable = require('../models/Consumable');
const requirePermission = require('../middleware/requirePermission');
const { logOperation } = require('../utils/operationLogger');
const { validateImage, saveImage, deleteImageFile } = require('../utils/imageAttachment');
const { runExclusive } = require('../utils/entityMutationQueue');

/** 同一实体图片操作的互斥键，保证「读-改-写」串行，避免并发上传互相覆盖 */
const mutationKey = (entity, id) => `images:${entity}:${id}`;

// 实体注册表：新增支持图片的实体时，只需在此登记一行
const ENTITY_CONFIG = {
  devices: {
    Model: Device,
    pk: 'deviceId',
    permissions: ['device:create', 'device:edit'],
    module: 'device',
    label: '设备',
    nameAttr: 'name',
  },
  consumables: {
    Model: Consumable,
    pk: 'consumableId',
    permissions: ['consumable:create', 'consumable:edit'],
    module: 'consumable',
    label: '耗材',
    nameAttr: 'name',
  },
};

/**
 * 解析实体并按实体维度做权限校验
 */
function resolveEntity(req, res, next) {
  const entity = String(req.body?.entity || req.query?.entity || '').toLowerCase();
  const config = ENTITY_CONFIG[entity];
  if (!config) {
    return res.status(400).json({ success: false, message: '不支持的图片归属类型' });
  }
  req.imageEntity = entity;
  req.imageConfig = config;
  return requirePermission(...config.permissions)(req, res, next);
}

/**
 * 读取实体的图片数组（兼容历史 null 值）
 */
const getImages = record => (Array.isArray(record.images) ? record.images : []);

// 上传图片
router.post('/', resolveEntity, async (req, res) => {
  const { imageConfig, imageEntity } = req;
  try {
    const id = req.body?.id;
    const file = req.files?.image || req.files?.file;

    if (!id) {
      return res.status(400).json({ success: false, message: '缺少实体ID' });
    }

    const validation = validateImage(file);
    if (!validation.ok) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    // 串行执行「读-改-写」：并发上传时后一个请求一定能读到前一个已写入的结果，
    // 避免多个请求基于同一份旧数组各自覆盖，导致「上传多张只剩最后一张」
    const result = await runExclusive(mutationKey(imageEntity, id), async () => {
      const record = await imageConfig.Model.findByPk(id);
      if (!record) {
        return { notFound: true };
      }

      const meta = await saveImage(imageEntity, id, file);
      const images = [...getImages(record), meta];
      record.images = images;

      try {
        await record.save();
      } catch (saveError) {
        // 落库失败则回滚刚写入的磁盘文件，避免产生孤儿文件
        deleteImageFile(meta.url);
        throw saveError;
      }

      return { record, images, meta };
    });

    if (result.notFound) {
      return res.status(404).json({ success: false, message: `${imageConfig.label}不存在` });
    }

    const { record, images, meta } = result;

    await logOperation({
      module: imageConfig.module,
      operationType: 'upload',
      operationDescription: `上传${imageConfig.label}图片【${record[imageConfig.nameAttr] || id}】`,
      targetId: id,
      targetName: record[imageConfig.nameAttr] || id,
      afterState: { images },
      req,
      metadata: { imageUrl: meta.url, imageName: meta.name, imageSize: meta.size },
    });

    return res.json({ success: true, message: '图片上传成功', data: { images } });
  } catch (error) {
    return res.status(500).json({ success: false, message: '图片上传失败', error: error.message });
  }
});

// 删除图片
router.delete('/', resolveEntity, async (req, res) => {
  const { imageConfig, imageEntity } = req;
  try {
    const id = req.body?.id;
    const url = req.body?.url;

    if (!id || !url) {
      return res.status(400).json({ success: false, message: '缺少实体ID或图片地址' });
    }

    // 与上传共用同一互斥键：删除与并发上传/删除之间同样串行，避免互相覆盖
    const result = await runExclusive(mutationKey(imageEntity, id), async () => {
      const record = await imageConfig.Model.findByPk(id);
      if (!record) {
        return { notFound: 'entity' };
      }

      const current = getImages(record);
      if (!current.some(img => img?.url === url)) {
        return { notFound: 'image' };
      }

      const images = current.filter(img => img?.url !== url);
      record.images = images;
      await record.save();

      // 先落库再删文件，避免删文件成功但落库失败导致数据不一致
      deleteImageFile(url);

      return { record, images, current };
    });

    if (result.notFound === 'entity') {
      return res.status(404).json({ success: false, message: `${imageConfig.label}不存在` });
    }
    if (result.notFound === 'image') {
      return res.status(404).json({ success: false, message: '图片不存在' });
    }

    const { record, images, current } = result;

    await logOperation({
      module: imageConfig.module,
      operationType: 'delete',
      operationDescription: `删除${imageConfig.label}图片【${record[imageConfig.nameAttr] || id}】`,
      targetId: id,
      targetName: record[imageConfig.nameAttr] || id,
      beforeState: { images: current },
      afterState: { images },
      req,
      metadata: { imageUrl: url },
    });

    return res.json({ success: true, message: '图片删除成功', data: { images } });
  } catch (error) {
    return res.status(500).json({ success: false, message: '图片删除失败', error: error.message });
  }
});

module.exports = router;
