process.env.JWT_SECRET = 'test-secret-key-for-jest-testing-minimum-32-chars-long';
process.env.NODE_ENV = 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';

const path = require('path');
const fs = require('fs');
const request = require('supertest');
const express = require('express');
const fileUpload = require('express-fileupload');

// 跳过权限校验中间件，聚焦图片上传/删除逻辑
jest.mock('../middleware/requirePermission', () => () => (req, res, next) => next());

const { sequelize } = require('../db');
const Device = require('../models/Device');
const Consumable = require('../models/Consumable');
const imageAttachment = require('../utils/imageAttachment');

const createTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(fileUpload({ limits: { fileSize: 20 * 1024 * 1024 } }));
  app.use('/api/images', require('../routes/images'));
  return app;
};

// 最小合法 PNG 头（用于校验通过）
const PNG_BUFFER = Buffer.from('89504e470d0a1a0a0000000d494844520000', 'hex');

const absOf = url => path.join(__dirname, '..', url);

describe('图片附件工具（单元）', () => {
  it('validateImage 拒绝空文件', () => {
    expect(imageAttachment.validateImage(null).ok).toBe(false);
  });

  it('validateImage 拒绝非图片类型', () => {
    expect(imageAttachment.validateImage({ mimetype: 'application/pdf', size: 10 }).ok).toBe(false);
  });

  it('validateImage 拒绝超限大小', () => {
    const big = { mimetype: 'image/png', size: imageAttachment.MAX_IMAGE_SIZE + 1 };
    expect(imageAttachment.validateImage(big).ok).toBe(false);
  });

  it('validateImage 接受合法图片', () => {
    expect(imageAttachment.validateImage({ mimetype: 'image/jpeg', size: 1024 }).ok).toBe(true);
  });

  it('deleteImageFile 阻止目录穿越与非 uploads 路径', () => {
    expect(imageAttachment.deleteImageFile('/uploads/../secret.txt')).toBe(false);
    expect(imageAttachment.deleteImageFile('/etc/passwd')).toBe(false);
    expect(imageAttachment.deleteImageFile('')).toBe(false);
  });
});

describe('图片附件路由', () => {
  let deviceId;
  let consumableId;
  const createdFiles = [];

  beforeAll(async () => {
    await sequelize.sync({ force: true });
    const device = await Device.create({
      name: 'IMG-DEV',
      type: 'server',
      serialNumber: 'SN-IMG-1',
      status: 'offline',
    });
    deviceId = device.deviceId;
    const consumable = await Consumable.create({ name: 'IMG-CON', category: '线缆' });
    consumableId = consumable.consumableId;
  });

  afterAll(() => {
    createdFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* 忽略清理失败 */
      }
    });
  });

  it('上传设备图片成功并写入 images 数组', async () => {
    const res = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'devices')
      .field('id', deviceId)
      .attach('image', PNG_BUFFER, 'front.png');

    expect(res.status).toBe(200);
    expect(res.body.data.images).toHaveLength(1);

    const url = res.body.data.images[0].url;
    expect(url).toMatch(/^\/uploads\/devices\//);
    createdFiles.push(absOf(url));
    expect(fs.existsSync(absOf(url))).toBe(true);

    const fresh = await Device.findByPk(deviceId);
    expect(Array.isArray(fresh.images)).toBe(true);
    expect(fresh.images).toHaveLength(1);
  });

  it('拒绝非图片类型', async () => {
    const res = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'devices')
      .field('id', deviceId)
      .attach('image', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('拒绝不支持的实体类型', async () => {
    const res = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'hackers')
      .field('id', deviceId)
      .attach('image', PNG_BUFFER, 'x.png');
    expect(res.status).toBe(400);
  });

  it('实体不存在返回 404', async () => {
    const res = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'devices')
      .field('id', 'DEV-NOT-EXIST')
      .attach('image', PNG_BUFFER, 'x.png');
    expect(res.status).toBe(404);
  });

  it('上传耗材图片成功', async () => {
    const res = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'consumables')
      .field('id', consumableId)
      .attach('image', PNG_BUFFER, 'con.png');

    expect(res.status).toBe(200);
    expect(res.body.data.images).toHaveLength(1);
    createdFiles.push(absOf(res.body.data.images[0].url));

    const fresh = await Consumable.findByPk(consumableId);
    expect(fresh.images).toHaveLength(1);
  });

  it('删除图片成功并移除磁盘文件', async () => {
    const up = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'devices')
      .field('id', deviceId)
      .attach('image', PNG_BUFFER, 'to-delete.png');

    const url = up.body.data.images[up.body.data.images.length - 1].url;
    createdFiles.push(absOf(url));
    expect(fs.existsSync(absOf(url))).toBe(true);

    const del = await request(createTestApp())
      .delete('/api/images')
      .send({ entity: 'devices', id: deviceId, url });

    expect(del.status).toBe(200);
    expect(del.body.data.images.some(img => img.url === url)).toBe(false);
    expect(fs.existsSync(absOf(url))).toBe(false);
  });

  it('删除不存在的图片返回 404', async () => {
    const res = await request(createTestApp())
      .delete('/api/images')
      .send({ entity: 'devices', id: deviceId, url: '/uploads/devices/not-there.png' });
    expect(res.status).toBe(404);
  });

  it('缺少实体ID时返回 400', async () => {
    const res = await request(createTestApp())
      .post('/api/images')
      .field('entity', 'devices')
      .attach('image', PNG_BUFFER, 'x.png');
    expect(res.status).toBe(400);
  });
});

describe('图片附件 - 并发写入（回归：读-改-写覆盖）', () => {
  let deviceId;
  const createdFiles = [];

  beforeAll(async () => {
    const device = await Device.create({
      name: 'IMG-CONCURRENT',
      type: 'server',
      serialNumber: 'SN-IMG-CONC',
      status: 'offline',
    });
    deviceId = device.deviceId;
  });

  afterAll(() => {
    createdFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* 忽略清理失败 */
      }
    });
  });

  it('并发上传 3 张图片应全部保留，不互相覆盖', async () => {
    const app = createTestApp();

    // 模拟前端一次选择 3 张：3 个请求同时发出
    const responses = await Promise.all(
      ['a.png', 'b.png', 'c.png'].map(name =>
        request(app)
          .post('/api/images')
          .field('entity', 'devices')
          .field('id', deviceId)
          .attach('image', PNG_BUFFER, name)
      )
    );

    responses.forEach(res => expect(res.status).toBe(200));

    const fresh = await Device.findByPk(deviceId);
    const urls = fresh.images.map(img => img.url);

    // 关键断言：三张都在，且 url 互不相同
    expect(fresh.images).toHaveLength(3);
    expect(new Set(urls).size).toBe(3);

    urls.forEach(url => {
      createdFiles.push(absOf(url));
      expect(fs.existsSync(absOf(url))).toBe(true);
    });

    // 每个响应都应看到「截至它自己写入时」的累计结果，最后一次为 3 张
    const lastCount = Math.max(...responses.map(r => r.body.data.images.length));
    expect(lastCount).toBe(3);
  });
});
