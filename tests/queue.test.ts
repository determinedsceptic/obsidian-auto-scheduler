import { expect, it } from 'vitest';
import { OperationQueue } from '../src/queue';
it('快速设置输入逐项执行，不丢弃且应用看见最新设置', async () => {
  const queue = new OperationQueue(); let path = ''; const writes: string[] = [];
  await Promise.all(['T', 'Ta', 'Tas', 'Task', 'Tasks'].map(value => queue.run(async () => { await Promise.resolve(); path = value; writes.push(value); })));
  expect(writes).toEqual(['T', 'Ta', 'Tas', 'Task', 'Tasks']);
  expect(await queue.run(async () => path)).toBe('Tasks');
});
it('写入失败不会阻止下一次操作', async () => {
  const queue = new OperationQueue();
  const first = queue.run(async () => { throw new Error('失败'); });
  const second = queue.run(async () => '后续操作');
  await expect(first).rejects.toThrow('失败'); await expect(second).resolves.toBe('后续操作');
});
