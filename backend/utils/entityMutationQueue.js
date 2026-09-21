'use strict';

/**
 * 实体级串行队列（互斥执行）
 *
 * 解决的问题：对同一实体的「读 → 改 → 写」在并发下会互相覆盖。
 * 典型场景：前端一次选择多张图片，multipart 会并发发出多个上传请求，
 * 每个请求都先 findByPk 读到同一份旧数组，各自追加后写回，
 * 结果只有最后一次写入生效（表现为「上传 3 张只剩最后 1 张」）。
 *
 * 语义：相同 key 的任务严格串行（前一个 settle 后才执行下一个），不同 key 互不阻塞。
 * 单个任务失败不会中断该 key 的后续任务。
 *
 * @param {string} key  互斥键，如 `images:devices:DEV123`
 * @param {Function} task 待执行的任务 () => Promise<T>
 * @returns {Promise<T>} 任务自身的返回值/异常（会原样透传给调用方）
 */

// key -> 链尾 promise（该 promise 永不 reject，用于串联而非传播失败）
const chains = new Map();

function runExclusive(key, task) {
  const prev = chains.get(key) || Promise.resolve();

  // 前一个任务无论成功或失败，都继续执行当前任务
  const result = prev.then(
    () => task(),
    () => task()
  );

  // 链尾吞掉异常，避免单个失败导致整条链断裂
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);

  // 链尾已无后继时回收，防止 Map 无限增长
  tail.then(() => {
    if (chains.get(key) === tail) {
      chains.delete(key);
    }
  });

  return result;
}

/** 当前活跃的互斥键数量（用于测试/观测） */
const pendingKeys = () => chains.size;

module.exports = { runExclusive, pendingKeys };
