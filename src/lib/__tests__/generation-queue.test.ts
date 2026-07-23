import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GenerationQueue } from '../generation-queue';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GenerationQueue (#70 panic-wipe fence)', () => {
  it('lets a job write when not invalidated', async () => {
    const q = new GenerationQueue();
    let wrote = false;
    await q.run(async (stillValid) => {
      assert.equal(stillValid(), true);
      wrote = true;
    });
    assert.equal(wrote, true);
  });

  it('invalidation stops an in-flight persist after its await', async () => {
    const q = new GenerationQueue();
    let wrote = false;

    const job = q.run(async (stillValid) => {
      await delay(30);
      if (!stillValid()) return;
      wrote = true;
    });

    // Panic wipe: bump generation, then wait for the queue to settle.
    await delay(5);
    q.invalidate();
    await q.drain();
    await job;

    assert.equal(wrote, false, 'stale snapshot must not write after invalidate');
  });

  it('queued work started after invalidate still runs under the new generation', async () => {
    const q = new GenerationQueue();
    const writes: string[] = [];

    const stale = q.run(async (stillValid) => {
      await delay(20);
      if (!stillValid()) return;
      writes.push('stale');
    });

    q.invalidate();
    await q.drain();
    await stale;

    await q.run(async (stillValid) => {
      assert.equal(stillValid(), true);
      writes.push('fresh');
    });

    assert.deepEqual(writes, ['fresh']);
  });

  it('serialises concurrent run() calls', async () => {
    const q = new GenerationQueue();
    const order: number[] = [];

    await Promise.all([
      q.run(async () => {
        await delay(20);
        order.push(1);
      }),
      q.run(async () => {
        order.push(2);
      }),
    ]);

    assert.deepEqual(order, [1, 2]);
  });
});
