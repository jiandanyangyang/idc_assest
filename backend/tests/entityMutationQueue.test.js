'use strict';

const { runExclusive, pendingKeys } = require('../utils/entityMutationQueue');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('entityMutationQueue（实体级串行队列）', () => {
  it('同一 key 的任务严格串行执行', async () => {
    const order = [];

    await Promise.all([
      runExclusive('same-key', async () => {
        order.push('a-start');
        await sleep(20);
        order.push('a-end');
      }),
      runExclusive('same-key', async () => {
        order.push('b-start');
        await sleep(5);
        order.push('b-end');
      }),
    ]);

    // 第二个任务必须等第一个完全结束后才开始
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('读-改-写串行后不丢更新（并发上传只剩最后一张的根因）', async () => {
    let images = [];

    // 模拟三个并发上传：各自「读 → 改 → 写」
    await Promise.all(
      [1, 2, 3].map(n =>
        runExclusive('images:devices:DEV1', async () => {
          const current = [...images];
          await sleep(10);
          images = [...current, { n }];
        })
      )
    );

    expect(images).toHaveLength(3);
    expect(images.map(i => i.n)).toEqual([1, 2, 3]);
  });

  it('不同 key 之间互不阻塞', async () => {
    const order = [];

    await Promise.all([
      runExclusive('k-1', async () => {
        await sleep(30);
        order.push('k1');
      }),
      runExclusive('k-2', async () => {
        order.push('k2');
      }),
    ]);

    // k-2 无需等待 k-1 的长任务
    expect(order).toEqual(['k2', 'k1']);
  });

  it('单个任务失败不会中断该 key 的后续任务', async () => {
    const order = [];

    const failed = runExclusive('k-fail', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const next = runExclusive('k-fail', async () => {
      order.push('second');
      return 'ok';
    });

    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });

  it('任务返回值原样透传给调用方', async () => {
    await expect(runExclusive('k-ret', async () => ({ value: 42 }))).resolves.toEqual({
      value: 42,
    });
  });

  it('全部任务结束后回收 key，避免内存泄漏', async () => {
    await runExclusive('k-clean', async () => 'done');
    await sleep(0);
    expect(pendingKeys()).toBe(0);
  });
});
