import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { CodexAppServer } from '../src/codex-app-server.js';

test('treats already-initialized app-server responses as ready', async () => {
  const client = new EventEmitter();
  client.requests = [];
  client.notifications = [];
  client.start = () => {};
  client.stop = () => {};
  client.request = async (method, params) => {
    client.requests.push({ method, params });
    const error = new Error('Already initialized');
    error.code = -32600;
    throw error;
  };
  client.notify = (method, params) => client.notifications.push({ method, params });

  const server = new CodexAppServer({ client });
  let ready = null;
  server.on('ready', (event) => {
    ready = event;
  });

  await server.start();

  assert.equal(client.requests[0].method, 'initialize');
  assert.deepEqual(client.notifications, []);
  assert.deepEqual(ready, { reconnect: false });
});

test('rename failures propagate so Telegram cannot report a false success', async () => {
  const client = new EventEmitter();
  client.request = async () => { throw new Error('rename rejected'); };
  const server = new CodexAppServer({ client });
  await assert.rejects(server.renameThread('t1', 'New name'), /rename rejected/);
});

test('readThread fetches source metadata without loading turns', async () => {
  const client = new EventEmitter();
  const thread = { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } };
  client.request = async (method, params) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'child', includeTurns: false });
    return { thread };
  };
  const server = new CodexAppServer({ client });
  assert.deepEqual(await server.readThread('child'), thread);
});
