import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-support/archive-fixture.mjs';

// Draft text and selection live in the browser. The host sees the same message-free
// log for an untouched composer and for one with an unsent draft, so both must survive.
test('message-free composer survives repeated timer and link sweeps beyond 90 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const f = await fixture();
  try {
    const a = await f.add(101, { message: false });
    await f.restart(); // Start the real maintenance effect while the blank is still new.
    const workspace = f.workspaces.find(w => w.sessionIds.includes(a.id));
    const log = JSON.stringify(f.events.get(a.id));
    for (let i = 0; i < 8; i++) {
      t.mock.timers.tick(15_000);
      await f.request(); // Drain serialized timer work and exercise the HTTP path too.
      assert.equal(f.archived.has(a.id), false, `composer archived after ${(i + 1) * 15}s`);
      assert.ok(f.workspaces.includes(workspace));
      assert.equal(await realpath(join(f.root, 'Room-101')), a.directory);
      assert.equal((await stat(a.directory)).isDirectory(), true);
      assert.equal(JSON.stringify(f.events.get(a.id)), log);
    }
  } finally { await f.close(); t.mock.timers.reset(); }
});

test('restoring an expired blank remains effective across runtime maintenance', async () => {
  const f = await fixture();
  try {
    const a = await f.add(102, { message: false });
    f.events.get(a.id)[0].time = Date.now() - 180_000;
    f.archived.add(a.id);
    await f.request();
    await f.registry.unarchiveSession(a.id);
    for (let i = 0; i < 3; i++) {
      await f.request();
      assert.equal(f.archived.has(a.id), false);
      assert.equal(await realpath(join(f.root, 'Room-102')), a.directory);
    }
  } finally { await f.close(); }
});

test('activation preserves expired blanks, missing timestamps and conversations; only archived empty cwds are reclaimed', async () => {
  const f = await fixture();
  try {
    const expired = await f.add(103, { message: false });
    const noTimestamp = await f.add(104, { message: false });
    const conversation = await f.add(105);
    const archived = await f.add(106, { message: false });
    f.events.get(expired.id)[0].time = Date.now() - 180_000;
    delete f.events.get(noTimestamp.id)[0].time;
    for (const event of f.events.get(conversation.id)) event.time = Date.now() - 180_000;
    f.archived.add(archived.id);
    for (let i = 0; i < 2; i++) {
      await f.restart();
      assert.equal(f.archived.has(archived.id), true);
      await assert.rejects(stat(archived.directory), { code: 'ENOENT' });
      for (const kept of [expired, noTimestamp, conversation]) {
        assert.equal(f.archived.has(kept.id), false);
        assert.equal((await stat(kept.directory)).isDirectory(), true);
        assert.ok(f.workspaces.some(w => w.sessionIds.includes(kept.id)));
      }
    }
  } finally { await f.close(); }
});
