import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CodexTelegramTopicBridge } from '../src/bridge.js';

const execFileAsync = promisify(execFile);

test('/bind stores group without creating topics for existing discovered threads', async () => {
  const state = memoryState();
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 't1', title: 'One' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/bind', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.equal(state.boundChatId, '-100');
  assert.equal(state.getTopicForThread('t1'), null);
  assert.deepEqual(telegram.created, []);
  assert.deepEqual(codex.resumed, []);
});

test('newly discovered threads after startup get topics', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: now - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [{ id: 'old', title: 'Old', createdAt: now - 10000 }, { id: 'new', title: 'New', createdAt: Date.now() + 1000 }];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('old'), null);
  assert.equal(state.getTopicForThread('new'), 1001);
  assert.deepEqual(codex.resumed, ['new']);
});

test('older unseen threads after startup are not backfilled', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old-a', title: 'Old A', createdAt: now - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [
    { id: 'old-a', title: 'Old A', createdAt: now - 10000 },
    { id: 'old-b', title: 'Old B', createdAt: now - 9000 },
  ];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('old-a'), null);
  assert.equal(state.getTopicForThread('old-b'), null);
  assert.deepEqual(telegram.created, []);
});

test('unmapped old threads get topics when updated after startup', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: Date.now() - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [{ id: 'old', title: 'Old', updatedAt: Date.now() + 1000 }];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('old'), 1001);
  assert.deepEqual(codex.resumed, ['old']);
});

test('mapped threads are resumed on startup and events are mirrored', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: Date.now() - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/agentMessage/delta',
    threadId: 'old',
    raw: { params: { threadId: 'old', role: 'assistant', text: 'hello' } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.resumed, ['old']);
  assert.equal(telegram.sent.at(-1).messageThreadId, 44);
  assert.match(telegram.sent.at(-1).text, /hello/);
});

test('mapped CLI session files are tailed for new messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-cli-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, `${sessionLine('user_message', { message: 'old' })}\n`, 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('cli-thread', 44, 'CLI');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'cli-thread', title: 'CLI', source: 'cli', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  assert.deepEqual(telegram.sent, []);

  await appendFile(file, `${sessionLine('user_message', { message: 'from cli' })}\n${sessionLine('agent_message', { message: 'from assistant' })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), ['user_message\nUser\nfrom cli', 'agent_message\nCodex\nfrom assistant']);
});

test('mapped session files are tailed even when app-server reports vscode source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-vscode-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, `${sessionLine('user_message', { message: 'old' })}\n`, 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('vscode-thread', 44, 'VS Code');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'vscode-thread', title: 'VS Code', source: 'vscode', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await appendFile(file, `${sessionLine('agent_message', { message: 'from assistant' })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), ['agent_message\nCodex\nfrom assistant']);
});

test('session file tailing ignores assistant response items and preserves user records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-response-item-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('response-thread', 44, 'Response');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'response-thread', title: 'Response', source: 'vscode', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await appendFile(file, `${responseMessageLine('assistant', 'from response item')}\n${responseMessageLine('user', 'from user response item')}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), ['response_item/message\nUser\nfrom user response item']);
});

test('session file tailing mirrors response_item tool records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-response-tool-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('tool-thread', 44, 'Tool');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'tool-thread', title: 'Tool', source: 'vscode', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await appendFile(file, `${responseToolCallLine('apply_patch')}\n${responseToolOutputLine('Exit code: 0\nOutput:\nSuccess')}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), [
    'custom_tool_call\nTool call: apply_patch (completed)',
    'custom_tool_call_output\nTool output\nExit code: 0\nOutput:\nSuccess',
  ]);
});

test('Telegram conversation scope mirrors messages silently and alerts on completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-conversation-scope-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('scope-thread', 44, 'Scope');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'scope-thread', title: 'Scope', source: 'vscode', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], messageScope: 'conversation' });

  await bridge.start();
  await appendFile(file, `${sessionLine('user_message', { message: 'from user' })}\n${responseToolCallLine('apply_patch')}\n${sessionLine('agent_message', { message: 'from assistant' })}\n${sessionLine('task_complete', {})}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.slice(0, 2).map((message) => message.text), ['user_message\nUser\nfrom user', 'agent_message\nCodex\nfrom assistant']);
  assert.ok(telegram.sent.slice(0, 2).every(message => !message.notify));
  assert.equal(telegram.sent.length, 3);
  assert.equal(telegram.sent[2].notify, true);
});

test('Telegram messageScope=none disables mirrored Codex transcript messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-none-scope-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('none-thread', 44, 'None');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'none-thread', title: 'None', source: 'vscode', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], messageScope: 'none' });

  await bridge.start();
  await appendFile(file, `${sessionLine('user_message', { message: 'from user' })}\n${sessionLine('agent_message', { message: 'from assistant' })}\n`, 'utf8');
  await bridge.discoverThreads();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 'none-thread',
    raw: { params: { threadId: 'none-thread', item: { id: 'agent-1', type: 'agentMessage', text: 'live assistant' } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(telegram.sent, []);
});

test('session file tailing sends debug notices for message records without text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-debug-skip-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('debug-thread', 44, 'Debug');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'debug-thread', title: 'Debug', source: 'unknown-source', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await appendFile(file, `${responseMessageLine('user', '')}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /Debug: Codex message not sent to Telegram/);
  assert.match(telegram.sent.at(-1).text, /response_item user message had no text content/);
});

test('session file tailing sends task completion notices at high priority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-task-complete-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('done-thread', 44, 'Done');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'done-thread', title: 'Done', source: 'exec', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await appendFile(file, `${sessionLine('task_complete', { duration_ms: 305000 })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /Status: Codex task complete/);
  assert.match(telegram.sent.at(-1).text, /Duration: 5m 5s/);
  assert.equal(telegram.sent.at(-1).priority, 'high');
});

test('CLI session tailing does not duplicate messages already mirrored from app-server events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-cli-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('cli-thread', 44, 'CLI');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'cli-thread', title: 'CLI', source: 'cli', path: file, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 'cli-thread',
    raw: { params: { threadId: 'cli-thread', item: { id: 'agent-1', type: 'agentMessage', text: 'same answer' } } },
  });
  await tick();
  await appendFile(file, `${sessionLine('agent_message', { message: 'same answer' })}\n`, 'utf8');
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.sent.map((message) => message.text), ['agentMessage\nCodex\nsame answer']);
});

test('newly discovered CLI session files do not replay history after topic creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-cli-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, `${sessionLine('user_message', { message: 'first prompt' })}\n${sessionLine('agent_message', { message: 'first answer' })}\n`, 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const now = Date.now();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', createdAt: now - 10000, updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.threads = [
    { id: 'old', title: 'Old', createdAt: now - 10000, updatedAt: '1' },
    { id: 'cli-thread', title: 'CLI', source: 'cli', path: file, createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 },
  ];
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(state.getTopicForThread('cli-thread'), 1001);
  assert.deepEqual(telegram.sent.map((message) => message.text), [
    'Linked Codex thread cli-thread',
  ]);
});

test('agent message deltas send nothing until the message completes', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: Date.now() - 10000 }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  for (const delta of ['Hi', '. ', 'What ', 'do ', 'you ', 'want?']) {
    codex.emit('event', {
      method: 'item/agentMessage/delta',
      threadId: 'old',
      raw: { params: { threadId: 'old', itemId: 'item-1', delta } },
    });
  }
  await tick();
  assert.equal(telegram.sent.length, 0);
  assert.equal(telegram.edited.length, 0);

  codex.emit('event', {
    method: 'item/completed',
    threadId: 'old',
    raw: { params: { threadId: 'old', item: { id: 'item-1', type: 'agentMessage', text: 'Hi. What do you want?' } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, 'agentMessage\nCodex\nHi. What do you want?');
  assert.equal(telegram.edited.length, 0);
});

test('duplicate completion during a slow send does not send or edit again', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const send = telegram.sendMessage;
  telegram.sendMessage = async message => {
    const result = await send(message);
    await pending;
    return result;
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state });
  await bridge.start();
  try {
    codex.emit('event', {
      method: 'item/agentMessage/delta', threadId: 't1',
      raw: { params: { itemId: 'a1', delta: 'Partial' } },
    });
    await tick();
    codex.emit('event', {
      method: 'item/completed', threadId: 't1',
      raw: { params: { item: { id: 'a1', type: 'agentMessage', text: 'Final answer' } } },
    });
    await tick();
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.edited.length, 0);
    codex.emit('event', {
      method: 'item/completed', threadId: 't1',
      raw: { params: { item: { id: 'a1', type: 'agentMessage', text: 'Final answer' } } },
    });
    await tick();
    release();
    await tick();
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.edited.length, 0);
    assert.equal(telegram.sent[0].text, 'agentMessage\nCodex\nFinal answer');
  } finally {
    release();
    await bridge.stop();
  }
});

test('thread status changes are not mirrored', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '1' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'thread/status/changed',
    threadId: 'old',
    raw: { params: { threadId: 'old', status: { type: 'idle' } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(telegram.sent, []);
});

test('turn completion sends a high priority status notice with backlog count', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  telegram.pendingOutboundCount = () => 7;
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', { method: 'turn/completed', threadId: 't1', raw: { params: { threadId: 't1' } } });
  await tick();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /Status: Codex task complete/);
  assert.match(telegram.sent.at(-1).text, /7 queued items/);
  assert.equal(telegram.sent.at(-1).priority, 'high');
});

test('control events without text do not send debug notices', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  for (const method of ['turn/started', 'warning', 'item/started', 'item/completed']) {
    codex.emit('event', { method, threadId: 't1', raw: { params: { threadId: 't1' } } });
  }
  await tick();
  await bridge.stop();

  assert.deepEqual(telegram.sent, []);
});

test('message-like app-server events without text send one debug notice', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { type: 'agentMessage' } } },
  });
  await tick();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /app-server event had no mirrorable text/);
  assert.match(telegram.sent.at(-1).text, /item\/completed/);
});

test('topic replies route to the mapped Codex thread', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: {
      text: 'continue',
      from: { id: 111111111 },
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'continue' }]);
});

test('telegram-originated topic replies are not mirrored back as user echoes', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'hi' }]);
  assert.deepEqual(telegram.sent, []);
});

test('telegram-originated echoes are suppressed when Codex emits before send resolves', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  codex.sendToThread = async (threadId, text) => {
    codex.sent.push({ threadId, text });
    codex.emit('event', {
      method: 'item/completed',
      threadId,
      raw: { params: { threadId, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text }] } } },
    });
    await tick();
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'hi' }]);
  assert.deepEqual(telegram.sent, []);
});

test('telegram-originated echoes are suppressed even if Codex reports a different thread id', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('routed-thread', 44, 'Routed');
  await state.mapThread('event-thread', 45, 'Event');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 'event-thread',
    raw: { params: { threadId: 'event-thread', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, [{ threadId: 'routed-thread', text: 'hi' }]);
  assert.deepEqual(telegram.sent, []);
});

test('desktop-originated user messages still mirror with a user label', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'from desktop' }] } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, 'userMessage\nUser\nfrom desktop');
});

test('topic replies in unmapped topics are silently ignored', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 99,
    }),
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, []);
  assert.deepEqual(telegram.sent, []);
});

test('only the owning bridge processes new commands delivered to multiple bots', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-topic-owner-'));
  for (const command of ['/new', '/new@arjun_codex_notifier_win_bot']) {
    await t.test(command, async (t) => {
      const clients = [];
      for (const topic of [44, 45]) {
        const state = memoryState();
        await state.bindChat(-100);
        await state.mapThread('existing', topic, 'Existing');
        const telegram = fakeTelegram();
        const codex = fakeCodex();
        codex.readThread = async () => ({ id: 'existing', cwd });
        const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });
        await bridge.start();
        t.after(() => bridge.stop());
        clients.push({ telegram, codex });
      }
      for (const { telegram } of clients) {
        telegram.emit('update', { message: allowedMessage({ text: `${command} New chat`, chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
      }
      await delay(50);
      assert.deepEqual(clients[0].codex.created, [{ title: 'New chat', options: { cwd } }]);
      assert.equal(clients[0].telegram.created.length, 1);
      assert.deepEqual(clients[1].codex.created, []);
      assert.deepEqual(clients[1].telegram.created, []);
      assert.deepEqual(clients[1].telegram.sent, []);
    });
  }
});

test('commands in unowned topics are silent, including unauthorized users and other groups', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('existing', 44, 'Existing');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });
  await bridge.start();
  t.after(() => bridge.stop());
  for (const [chatId, topic] of [[-100, 99], [-200, 44]]) {
    for (const userId of [111111111, 123]) {
      for (const command of ['/help', '/status', '/pause', '/rename Wrong', '/interrupt', '/new@other_bot']) {
        telegram.emit('update', { message: { from: { id: userId }, text: command, chat: { id: chatId, type: 'supergroup' }, message_thread_id: topic, is_topic_message: true } });
      }
    }
  }
  await tick();
  assert.deepEqual(telegram.sent, []);
  assert.deepEqual(codex.created, []);
  assert.deepEqual(codex.interrupted, []);
  assert.deepEqual(codex.renamed, []);
  assert.equal(state.data.paused.mirroring, false);
});

test('allowed messages outside forum topics get guidance', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: 'hi',
      chat: { id: -100, type: 'supergroup' },
    }),
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, []);
  assert.match(telegram.sent.at(-1).text, /not inside a Telegram forum topic/);
});

test('/status reports bridge state', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: allowedMessage({
      text: '/status',
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    }),
  });
  await tick();
  await bridge.stop();

  const status = telegram.sent.at(-1).text;
  assert.match(status, /Codex Toolbox status/);
  assert.match(status, /Bound group: -100/);
  assert.match(status, /Mapped threads: 1/);
  assert.match(status, /Transcript streaming paused: no/);
  assert.match(status, /Pending approvals: 0/);
  assert.match(status, /Allowed users: 111111111/);
});

test('/help returns command list', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/help', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /\/delete_all_topics confirm/);
  assert.match(telegram.sent.at(-1).text, /\/relink <threadId>/);
});

test('/topics lists mappings and handles empty state', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/topics', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  assert.match(telegram.sent.at(-1).text, /No Codex topics/);

  await state.mapThread('t1', 44, 'One');
  telegram.emit('update', { message: allowedMessage({ text: '/topics', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /t1 -> topic 44 -> One/);
});

test('/delete_all_topics requires confirm', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/delete_all_topics', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), 44);
  assert.match(telegram.sent.at(-1).text, /Run \/delete_all_topics confirm/);
});

test('/delete_all_topics confirm deletes mapped topics and prevents immediate recreation', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('old', 44, 'Old');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '10' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/delete_all_topics confirm', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.discoverThreads();
  await bridge.stop();

  assert.deepEqual(telegram.deleted, [{ chatId: '-100', messageThreadId: 44 }]);
  assert.equal(state.boundChatId, '-100');
  assert.equal(state.getTopicForThread('old'), null);
  assert.deepEqual(telegram.created, []);
  assert.ok(state.data.deletedThreadBaselines.old);
});

test('/delete_all_topics confirm keeps failed mappings', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  await state.mapThread('t2', 45, 'Two');
  const telegram = fakeTelegram();
  telegram.deleteForumTopic = async (chatId, messageThreadId) => {
    if (Number(messageThreadId) === 45) throw new Error('delete denied');
    telegram.deleted.push({ chatId, messageThreadId });
  };
  const codex = fakeCodex();
  const logger = { error() {}, warn() {} };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], logger });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/delete_all_topics confirm', chat: { id: -100, type: 'supergroup' } }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), null);
  assert.equal(state.getTopicForThread('t2'), 45);
  assert.match(telegram.sent.at(-1).text, /Failed topics: 1/);
});

test('/unlink removes the current topic mapping without deleting it', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/unlink', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), null);
  assert.deepEqual(telegram.deleted, []);
  assert.match(telegram.sent.at(-1).text, /Unlinked Codex thread t1/);
});

test('/relink maps a topic to an existing thread and rejects missing thread ids', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{ id: 't1', title: 'One' }] });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/relink missing', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  assert.match(telegram.sent.at(-1).text, /was not found/);

  telegram.emit('update', { message: allowedMessage({ text: '/relink t1', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), 44);
  assert.deepEqual(codex.resumed, ['t1']);
});

test('/pause suppresses mirroring but still allows topic replies, and /resume re-enables mirroring', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/pause', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  const sentAfterPause = telegram.sent.length;
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-1', type: 'agentMessage', text: 'hidden' } } },
  });
  await tick();
  telegram.emit('update', { message: allowedMessage({ text: 'continue', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  telegram.emit('update', { message: allowedMessage({ text: '/resume', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  codex.emit('event', {
    method: 'item/completed',
    threadId: 't1',
    raw: { params: { threadId: 't1', item: { id: 'agent-2', type: 'agentMessage', text: 'visible' } } },
  });
  await tick();
  await bridge.stop();

  assert.equal(telegram.sent.length >= sentAfterPause, true);
  assert.equal(telegram.sent.some((message) => message.text === 'agentMessage\nCodex\nhidden'), false);
  assert.deepEqual(codex.sent, [{ threadId: 't1', text: 'continue' }]);
  assert.equal(telegram.sent.at(-1).text, 'agentMessage\nCodex\nvisible');
});

test('/rename updates Telegram, state, and Codex when possible', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/rename Better Name', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(telegram.edited, [{ chatId: '-100', messageThreadId: 44, title: 'Better Name' }]);
  assert.equal(state.data.threads.t1.title, 'Better Name');
  assert.deepEqual(codex.renamed, [{ threadId: 't1', title: 'Better Name' }]);
});

test('/logs returns redacted diagnostics', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const fakeToken = `123456789:${'abcdefghijklmnopqrstuvwxyz'}`;
  await state.recordError(`token ${fakeToken}`);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/logs', chat: { id: -100, type: 'supergroup' } }) });
  await delay(10);
  await bridge.stop();

  assert.match(telegram.sent.at(-1).text, /diagnostics/);
  assert.match(telegram.sent.at(-1).text, /\[redacted-token\]/);
  assert.equal(telegram.sent.at(-1).text.includes(fakeToken), false);
});

test('topic creation permission failures are reported to Telegram', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  telegram.createForumTopic = async () => {
    throw new Error('Bad Request: not enough rights to create a topic');
  };
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '1' }] });
  const logger = { error() {}, warn() {} };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], logger });

  await bridge.start();
  codex.threads = [
    { id: 'old', title: 'Old', updatedAt: Date.now() - 10000 },
    { id: 't1', title: 'One', createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000 },
  ];
  await bridge.discoverThreads();
  await tick();
  await bridge.stop();

  assert.equal(state.getTopicForThread('t1'), null);
  assert.match(telegram.sent.at(-1).text, /Could not create Telegram topic/);
});

test('topic creation rate limits pause repeated topic creation attempts', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  let attempts = 0;
  telegram.createForumTopic = async () => {
    attempts += 1;
    const error = new Error('Too Many Requests: retry after 60');
    error.retryAfter = 60;
    error.response = { error_code: 429 };
    throw error;
  };
  const codex = fakeCodex({ threads: [{ id: 'old', title: 'Old', updatedAt: '1' }] });
  const logger = { error() {}, warn() {} };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], logger });

  await bridge.start();
  codex.threads = [{ id: 'old', title: 'Old', updatedAt: Date.now() + 1000 }];
  await bridge.discoverThreads();
  await bridge.discoverThreads();
  await bridge.stop();

  assert.equal(attempts, 1);
  assert.equal(state.getTopicForThread('old'), null);
});

test('/new without --cwd opens the project selector', { timeout: 5000 }, async () => {
  const { root, restore } = await useTemporaryProjectsRoot();
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const sendMessage = telegram.sendMessage;
  let receivedReply;
  const reply = new Promise(resolve => { receivedReply = resolve; });
  telegram.sendMessage = async message => {
    const result = await sendMessage(message);
    receivedReply();
    return result;
  };
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  try {
    await createSelectableProject(root, 'toolbox');
    await bridge.start();
    telegram.emit('update', { message: allowedMessage({ text: '/new Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
    await reply;
  } finally {
    await bridge.stop();
    restore();
  }

  assert.deepEqual(codex.created, []);
  assert.match(telegram.sent.at(-1).text, /Select a project/);
  assert.ok(telegram.sent.at(-1).replyMarkup);
  assert.equal(telegram.sent.at(-1).replyMarkup.inline_keyboard.at(-1)[0].text, 'Help');
});

test('/new in a linked topic uses its conversation cwd unless explicitly overridden', async (t) => {
  const inherited = await mkdtemp(join(tmpdir(), 'codex-inherited-cwd-'));
  const override = await mkdtemp(join(tmpdir(), 'codex-override-cwd-'));
  for (const explicit of [false, true]) {
    await t.test(explicit ? 'explicit cwd wins' : 'inherits cwd with bot-qualified command', async (t) => {
      const state = memoryState();
      await state.bindChat(-100);
      await state.mapThread('existing', 44, 'Existing');
      const telegram = fakeTelegram();
      const codex = fakeCodex();
      const reads = [];
      codex.readThread = async id => { reads.push(id); return { id, cwd: inherited }; };
      const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });
      await bridge.start();
      t.after(() => bridge.stop());
      const args = explicit ? ` --cwd "${override}"` : '';
      telegram.emit('update', { message: allowedMessage({ text: `/new@arjun_codex_notifier_win_bot${args} New chat`, chat: { id: -100, type: 'supergroup' }, message_thread_id: 44, is_topic_message: true }) });
      await delay(50);
      assert.deepEqual(reads, explicit ? [] : ['existing']);
      assert.deepEqual(codex.created, [{ title: 'New chat', options: { cwd: explicit ? override : inherited } }]);
      assert.equal(state.getTopicForThread('existing'), 44);
      assert.equal(state.getTopicForThread('new-thread'), 1001);
    });
  }
});

test('/new in a linked topic reports missing cwd instead of using another directory', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('existing', 44, 'Existing');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });
  await bridge.start();
  t.after(() => bridge.stop());
  telegram.emit('update', { message: allowedMessage({ text: '/new', chat: { id: -100, type: 'supergroup' }, message_thread_id: 44, is_topic_message: true }) });
  await delay(50);
  assert.deepEqual(codex.created, []);
  assert.match(telegram.sent.at(-1).text, /Could not determine this conversation.*directory/);
});

test('/new accepts --cwd to start a Codex thread in a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-new-cwd-'));
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: `/new --cwd "${dir}" Investigate bug`, chat: { id: -100, type: 'supergroup' } }) });
  await delay(50);
  await bridge.stop();

  assert.deepEqual(codex.created[0], { title: 'Investigate bug', options: { cwd: dir } });
  assert.equal(state.getTopicForThread('new-thread'), 1001);
  assert.match(telegram.sent.at(-1).text, new RegExp(`Directory: ${escapeRegex(dir)}`));
});

test('/new project and worktree callbacks create a Codex thread in the selected worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-toolbox-projects-'));
  const root = join(dir, 'projects-shiprdev');
  const worktree = join(root, 'omniflow', 'main');
  await mkdir(worktree, { recursive: true });
  await execGit(['init'], worktree);
  const previousRoot = process.env.CODEX_PROJECTS_ROOT;
  process.env.CODEX_PROJECTS_ROOT = root;
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  try {
    await bridge.start();
    telegram.emit('update', { message: allowedMessage({ text: '/new Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
    await delay(20);
    const projectCallback = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
    telegram.emit('update', { callback_query: { id: 'project-cb', from: { id: 111111111 }, data: projectCallback } });
    await delay(20);
    const worktreeCallback = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
    telegram.emit('update', { callback_query: { id: 'worktree-cb', from: { id: 111111111 }, data: worktreeCallback } });
    await delay(20);
    await bridge.stop();
  } finally {
    if (previousRoot == null) delete process.env.CODEX_PROJECTS_ROOT;
    else process.env.CODEX_PROJECTS_ROOT = previousRoot;
  }

  assert.deepEqual(codex.created[0], { title: 'Investigate bug', options: { cwd: worktree } });
  assert.equal(state.getTopicForThread('new-thread'), 1001);
});

test('startup registers Telegram command menu when supported', async () => {
  const state = memoryState();
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  await bridge.stop();

  assert.deepEqual(telegram.commands.map((command) => command.command), ['new', 'topics', 'status', 'interrupt', 'rename', 'pause', 'resume', 'help']);
});

test('/new inline help callback sends help text', async () => {
  const { root, restore } = await useTemporaryProjectsRoot();
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  try {
    await createSelectableProject(root, 'toolbox');
    await bridge.start();
    telegram.emit('update', { message: allowedMessage({ text: '/new', chat: { id: -100, type: 'supergroup' } }) });
    await delay(100);
    const helpCallback = telegram.sent.at(-1).replyMarkup.inline_keyboard.at(-1)[0].callback_data;
    telegram.emit('update', { callback_query: { id: 'help-cb', from: { id: 111111111 }, data: helpCallback } });
    await delay(20);
  } finally {
    await bridge.stop();
    restore();
  }

  assert.match(telegram.sent.at(-1).text, /Codex Toolbox commands/);
  assert.match(telegram.sent.at(-1).text, /\/new Optional title/);
});

test('/new rejects missing or relative cwd values', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/new --cwd relative-path Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
  await delay(10);
  telegram.emit('update', { message: allowedMessage({ text: '/new --cwd /definitely/not/a/real/path Investigate bug', chat: { id: -100, type: 'supergroup' } }) });
  await delay(10);
  await bridge.stop();

  assert.deepEqual(codex.created, []);
  assert.match(telegram.sent.at(-2).text, /Use an absolute directory path/);
  assert.match(telegram.sent.at(-1).text, /Directory not found/);
});

test('/interrupt inside topic calls Codex interrupt', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/interrupt', chat: { id: -100, type: 'supergroup' }, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.interrupted, ['t1']);
});

test('approval callbacks answer server requests with decisions', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('serverRequest', { id: 8, method: 'server/approval', threadId: 't1', params: { command: 'ls' } });
  await tick();
  const callbackData = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
  telegram.emit('update', { callback_query: { id: 'cbq', from: { id: 111111111 }, data: callbackData } });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.answers, [{ id: 8, decision: 'accept', data: { threadId: 't1' } }]);
});

test('unauthorized users cannot route topic replies', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  telegram.emit('update', {
    message: {
      text: 'continue',
      from: { id: 123 },
      chat: { id: -100, type: 'supergroup' },
      is_topic_message: true,
      message_thread_id: 44,
    },
  });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.sent, []);
  assert.equal(telegram.sent.at(-1).chatId, -100);
  assert.equal(telegram.sent.at(-1).messageThreadId, 44);
  assert.match(telegram.sent.at(-1).text, /Telegram user 123 is not allowlisted/);
  assert.match(telegram.sent.at(-1).text, /TELEGRAM_ALLOWED_USER_IDS/);
});

test('unauthorized users cannot answer approval callbacks', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });

  await bridge.start();
  codex.emit('serverRequest', { id: 8, method: 'server/approval', threadId: 't1', params: { command: 'ls' } });
  await tick();
  const callbackData = telegram.sent.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
  telegram.emit('update', { callback_query: { id: 'cbq', from: { id: 123 }, data: callbackData } });
  await tick();
  await bridge.stop();

  assert.deepEqual(codex.answers, []);
  assert.equal(telegram.callbackAnswers.at(-1).text, 'You are not allowed to control this Codex bridge.');
});

function fakeCodex({ threads = [] } = {}) {
  const codex = new EventEmitter();
  codex.threads = threads;
  codex.resumed = [];
  codex.sent = [];
  codex.created = [];
  codex.interrupted = [];
  codex.answers = [];
  codex.renamed = [];
  codex.start = async () => {};
  codex.stop = () => {};
  codex.listThreads = async () => codex.threads;
  codex.readThread = async (threadId) => ({ source: 'cli', ...codex.threads.find(thread => thread.id === threadId), id: threadId });
  codex.resumeThread = async (threadId) => codex.resumed.push(threadId);
  codex.sendToThread = async (threadId, text) => codex.sent.push({ threadId, text });
  codex.createThread = async (title, options = {}) => {
    codex.created.push({ title, options });
    return 'new-thread';
  };
  codex.interrupt = async (threadId) => codex.interrupted.push(threadId);
  codex.renameThread = async (threadId, title) => codex.renamed.push({ threadId, title });
  codex.answerServerRequest = (id, decision, data) => codex.answers.push({ id, decision, data });
  return codex;
}

function fakeTelegram() {
  const telegram = new EventEmitter();
  telegram.sent = [];
  telegram.created = [];
  telegram.deleted = [];
  telegram.edited = [];
  telegram.callbackAnswers = [];
  telegram.commands = [];
  telegram.startPolling = async () => {};
  telegram.stopPolling = () => {};
  telegram.checkForumTopic = async () => true;
  telegram.createForumTopic = async (chatId, title) => {
    telegram.created.push({ chatId, title });
    return 1000 + telegram.created.length;
  };
  telegram.deleteForumTopic = async (chatId, messageThreadId) => {
    telegram.deleted.push({ chatId, messageThreadId });
  };
  telegram.editForumTopic = async (chatId, messageThreadId, title) => {
    telegram.edited.push({ chatId, messageThreadId, title });
  };
  telegram.sendMessage = async (message) => {
    telegram.sent.push(message);
    return { message_id: telegram.sent.length };
  };
  telegram.editMessageText = async (message) => {
    telegram.edited.push(message);
  };
  telegram.answerCallbackQuery = async (id, text) => {
    telegram.callbackAnswers.push({ id, text });
  };
  telegram.setMyCommands = async (commands) => {
    telegram.commands = commands;
  };
  return telegram;
}

function allowedMessage(message) {
  return { from: { id: 111111111 }, ...message };
}

function memoryState() {
  return {
    data: { boundChatId: null, threads: {}, topics: {}, approvals: {}, paused: { mirroring: false }, deletedThreadBaselines: {}, lastErrors: [] },
    get boundChatId() {
      return this.data.boundChatId;
    },
    async bindChat(chatId) {
      this.data.boundChatId = String(chatId);
    },
    getTopicForThread(threadId) {
      return this.data.threads[String(threadId)]?.messageThreadId ?? null;
    },
    getThread(threadId) {
      return this.data.threads[String(threadId)] ?? null;
    },
    getThreadForTopic(topicId) {
      return this.data.topics[String(topicId)]?.threadId ?? null;
    },
    async mapThread(threadId, messageThreadId, title) {
      this.data.threads[String(threadId)] = { threadId, messageThreadId, title };
      this.data.topics[String(messageThreadId)] = { messageThreadId, threadId };
    },
    async updateThreadTitle(threadId, title) {
      this.data.threads[String(threadId)].title = title;
      return true;
    },
    async unmapThread(threadId) {
      const thread = this.data.threads[String(threadId)] ?? null;
      if (!thread) return null;
      delete this.data.threads[String(threadId)];
      delete this.data.topics[String(thread.messageThreadId)];
      return thread;
    },
    async unmapTopic(topicId) {
      const topic = this.data.topics[String(topicId)] ?? null;
      if (!topic) return null;
      return this.unmapThread(topic.threadId);
    },
    async clearTopicMappings() {
      const threads = Object.values(this.data.threads);
      this.data.threads = {};
      this.data.topics = {};
      this.data.approvals = {};
      return threads;
    },
    async clearApprovals() {
      this.data.approvals = {};
    },
    async setMirroringPaused(paused) {
      this.data.paused.mirroring = Boolean(paused);
    },
    async markDeletedThreadBaselines(threadIds, timestamp = new Date().toISOString()) {
      for (const threadId of threadIds) this.data.deletedThreadBaselines[String(threadId)] = timestamp;
    },
    async recordError(message) {
      this.data.lastErrors.push({ message, createdAt: new Date().toISOString() });
      this.data.lastErrors = this.data.lastErrors.slice(-20);
    },
    async rememberApproval(callbackId, approval) {
      this.data.approvals[callbackId] = approval;
    },
    async takeApproval(callbackId) {
      const approval = this.data.approvals[callbackId] ?? null;
      delete this.data.approvals[callbackId];
      return approval;
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execGit(args, cwd) {
  await execFileAsync('git', args, { cwd });
}

async function useTemporaryProjectsRoot() {
  const root = await mkdtemp(join(tmpdir(), 'codex-toolbox-project-root-'));
  const previousRoot = process.env.CODEX_PROJECTS_ROOT;
  process.env.CODEX_PROJECTS_ROOT = root;
  return {
    root,
    restore() {
      if (previousRoot == null) delete process.env.CODEX_PROJECTS_ROOT;
      else process.env.CODEX_PROJECTS_ROOT = previousRoot;
    },
  };
}

async function createSelectableProject(root, name) {
  const project = join(root, name);
  await mkdir(project, { recursive: true });
  await execGit(['init'], project);
  return project;
}

function sessionLine(type, payload) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, ...payload },
  });
}

function responseMessageLine(role, text) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
  });
}

function responseToolCallLine(name) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call-1',
      name,
      input: '{}',
    },
  });
}

function responseToolOutputLine(output) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-1',
      output,
    },
  });
}

test('failed Codex rename leaves the Telegram name unchanged', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'Original');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  codex.renameThread = async () => { throw new Error('rename rejected'); };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });
  await bridge.start();
  telegram.emit('update', { message: allowedMessage({ text: '/rename New', chat: { id: -100, type: 'supergroup' }, is_topic_message: true, message_thread_id: 44 }) });
  await tick();
  await bridge.stop();
  assert.equal(state.data.threads.t1.title, 'Original');
  assert.deepEqual(telegram.edited, []);
});

test('Codex name events update the Telegram topic', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'Original');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111] });
  await bridge.start();
  codex.emit('event', { threadId: 't1', method: 'thread/name/updated', raw: {params:{threadName:'From Codex'}} });
  await tick();
  await bridge.stop();
  assert.equal(state.data.threads.t1.title, 'From Codex');
});

test('Telegram answers a structured Codex question without starting a new turn', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'Question');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  let answer;
  codex.answerUserInput = (id, answers) => { answer = {id, answers}; };
  codex.sendToThread = async () => { throw new Error('must answer the pending request'); };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, allowedUserIds: [111111111], messageScope: 'conversation' });
  await bridge.start();
  codex.emit('serverRequest', { id: 9, method: 'item/tool/requestUserInput', threadId: 't1', params: {questions: [{id:'q', question:'Which?', options:[{label:'First'}, {label:'Second'}]}]} });
  await tick();
  telegram.emit('update', {message: allowedMessage({text:'2',chat:{id:-100,type:'supergroup'},is_topic_message:true,message_thread_id:44})});
  await tick();
  await bridge.stop();
  assert.deepEqual(answer, {id:9, answers:{q:{answers:['Second']}}});
  assert.equal(telegram.sent.find(message => message.text.startsWith('Input needed')).notify, true);
  assert.ok(!telegram.sent.find(message => message.text === 'Answer sent to Codex.').notify);
});


test('streaming is silent and completion alerts deduplicate across live events and session tail per turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-notifications-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '', 'utf8');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  await state.mapThread('t2', 45, 'Two');
  const telegram = fakeTelegram();
  const codex = fakeCodex({threads: [{id:'t1',title:'One',source:'vscode',path:file,updatedAt:'1'}]});
  const bridge = new CodexTelegramTopicBridge({codex, telegram, state, allowedUserIds:[111111111], messageScope:'conversation'});
  await bridge.start();
  codex.emit('event', {method:'item/agentMessage/delta',threadId:'t1',raw:{params:{itemId:'a1',delta:'Working'}}});
  await tick();
  codex.emit('event', {method:'item/completed',threadId:'t1',raw:{params:{item:{id:'a1',type:'agentMessage',text:'Working'}}}});
  await tick();
  assert.ok(telegram.sent.length > 0);
  assert.ok(telegram.sent.every(message => !message.notify));
  codex.emit('event', {method:'turn/completed',threadId:'t1',turnId:'turn1',raw:{params:{}}});
  await tick();
  await appendFile(file, sessionLine('task_complete', {turn_id:'turn1'})+'\n');
  await bridge.discoverThreads();
  assert.equal(telegram.sent.filter(message => message.notify).length, 1);
  // Distinct turns and different agents must still alert, even immediately.
  codex.emit('event', {method:'turn/completed',threadId:'t1',turnId:'turn2',raw:{params:{}}});
  codex.emit('event', {method:'turn/completed',threadId:'t2',turnId:'turn1',raw:{params:{}}});
  await tick();
  assert.equal(telegram.sent.filter(message => message.notify).length, 3);
  await appendFile(file, sessionLine('task_complete', {turn_id:'turn3'})+'\n');
  await bridge.discoverThreads();
  codex.emit('event', {method:'turn/completed',threadId:'t1',turnId:'turn3',raw:{params:{}}});
  await tick();
  assert.equal(telegram.sent.filter(message => message.notify).length, 4);
  await bridge.stop();
});

test('approval and confidential-input requests alert in conversation scope', async () => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({codex, telegram, state, allowedUserIds:[111111111], messageScope:'conversation'});
  await bridge.start();
  codex.emit('serverRequest', {id:10,method:'item/commandExecution/requestApproval',threadId:'t1',params:{command:'example'}});
  await tick();
  codex.emit('serverRequest', {id:11,method:'item/tool/requestUserInput',threadId:'t1',params:{questions:[{id:'secret',question:'Secret?',isSecret:true}]}});
  await tick();
  assert.equal(telegram.sent.length, 2);
  assert.ok(telegram.sent.every(message => message.notify === true));
  await bridge.stop();
});

test('disabled user mirroring filters live and session users but preserves agent output, alerts, and replies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-agent-only-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '');
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex({threads:[{id:'t1',path:file,updatedAt:'1'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,allowedUserIds:[111111111],messageScope:'conversation',mirrorUserMessages:false});
  await bridge.start();
  try {
    codex.emit('event', {method:'item/completed',threadId:'t1',raw:{params:{item:{id:'u1',type:'userMessage',content:[{type:'text',text:'live user'}]}}}});
    codex.emit('event', {method:'message/completed',threadId:'t1',raw:{params:{role:'user',text:'alternate user'}}});
    await tick();
    await appendFile(file, [sessionLine('user_message',{message:'log user'}),responseMessageLine('user','response user'),sessionLine('agent_message', {message:'Agent answer'}),sessionLine('task_complete',{turn_id:'done1'})].join('\n')+'\n');
    await bridge.discoverThreads();
    assert.equal(telegram.sent.length,2);
    assert.match(telegram.sent[0].text,/Agent answer/);
    assert.ok(!telegram.sent[0].notify);
    assert.equal(telegram.sent[1].notify,true);
    codex.emit('event', {method:'item/completed',threadId:'t1',raw:{params:{item:{id:'a1',type:'agentMessage',text:'Live agent'}}}});
    await tick();
    assert.match(telegram.sent.at(-1).text,/Live agent/);
    telegram.emit('update', {message:allowedMessage({text:'Continue please',chat:{id:-100,type:'supergroup'},is_topic_message:true,message_thread_id:44})});
    await tick();
    assert.deepEqual(codex.sent,[{threadId:'t1',text:'Continue please'}]);
    codex.emit('serverRequest', {id:99,method:'item/tool/requestUserInput',threadId:'t1',params:{questions:[{id:'q',question:'Which option?'}]}});
    await tick();
    assert.match(telegram.sent.at(-1).text,/Input needed/);
    assert.equal(telegram.sent.at(-1).notify,true);
  } finally { await bridge.stop(); }
});

test('private alerts label current conversation and leave transcript and response controls in the topic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-private-alert-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '');
  const state = memoryState();
  await state.bindChat(-10012345);
  await state.mapThread('t1', 44, 'Original');
  const telegram = fakeTelegram();
  const codex = fakeCodex({threads:[{id:'t1',title:'Original',source:'vscode',path:file,updatedAt:'1'}]});
  let answer;
  codex.answerUserInput = (id, answers) => { answer = {id, answers}; };
  const bridge = new CodexTelegramTopicBridge({codex, telegram, state, alertChatId:'111111111', allowedUserIds:[111111111], messageScope:'conversation'});
  await bridge.start();
  try {
    await appendFile(file, sessionLine('agent_message', {message:'Final result'})+'\n');
    await appendFile(file, responseMessageLine('assistant', 'Final result\n<oai-mem-citation><citation_entries>memory reference</citation_entries></oai-mem-citation>')+'\n');
    await bridge.discoverThreads();
    await state.mapThread('t1', 44, 'Renamed *agent*');
    codex.emit('event', {method:'turn/completed',threadId:'t1',turnId:'turn1',raw:{params:{}}});
    await tick();
    codex.emit('event', {method:'turn/completed',threadId:'t1',turnId:'turn1',raw:{params:{}}});
    await tick();
    await appendFile(file, sessionLine('task_complete', {turn_id:'turn1'})+'\n');
    await bridge.discoverThreads();
    assert.equal(telegram.sent.filter(m => m.notify).length, 1);
    assert.ok(telegram.sent.some(m => m.chatId === '-10012345' && m.text.includes('Final result') && !m.notify));
    assert.equal(telegram.sent.filter(m => m.text.includes('Final result')).length, 1);
    assert.ok(telegram.sent.every(m => !m.text.includes('<oai-mem-citation>')));
    const completion = telegram.sent.find(m => m.notify);
    assert.equal(completion.chatId, '111111111');
    assert.equal(completion.messageThreadId, undefined);
    assert.ok(completion.text.includes('Renamed \\*agent\\*'));
    assert.ok(completion.text.includes('https://t.me/c/12345/44'));
    codex.emit('serverRequest', {id:9,method:'item/tool/requestUserInput',threadId:'t1',params:{questions:[{id:'q',question:'Which?',options:[{label:'First'}]}]}});
    await tick();
    telegram.emit('update', {message:allowedMessage({text:'1',chat:{id:-10012345,type:'supergroup'},is_topic_message:true,message_thread_id:44})});
    await tick();
    assert.deepEqual(answer, {id:9,answers:{q:{answers:['First']}}});
    codex.emit('serverRequest', {id:10,method:'item/commandExecution/requestApproval',threadId:'t1',params:{command:'example'}});
    await tick();
    codex.emit('serverRequest', {id:11,method:'item/tool/requestUserInput',threadId:'t1',params:{questions:[{id:'secret',question:'Do not forward secret prompt',isSecret:true}]}});
    await tick();
    assert.equal(telegram.sent.filter(m => m.notify).length, 4);
    assert.ok(telegram.sent.filter(m => m.chatId === '-10012345').every(m => !m.notify));
    assert.ok(telegram.sent.some(m => m.chatId === '-10012345' && m.replyMarkup));
    assert.ok(telegram.sent.filter(m => m.notify).every(m => !m.replyMarkup && !m.messageThreadId));
    assert.ok(!telegram.sent.some(m => m.text.includes('Do not forward secret prompt')));
  } finally { await bridge.stop(); }
});

test('discovery excludes sub-agent threads but creates topics for user threads', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state });
  await bridge.start();
  t.after(() => bridge.stop());
  codex.threads = [
    { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } },
    { id: 'review', source: 'subAgentReview' },
    { id: 'parent', source: 'cli', title: 'User conversation' },
  ].map(thread => ({ ...thread, createdAt: Date.now() + 1000 }));
  await bridge.discoverThreads();
  assert.deepEqual(telegram.created.map(topic => topic.title), ['User conversation']);
  assert.deepEqual(codex.resumed, ['parent']);
});

test('sub-agent events arriving before discovery do not create topics', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  let reads = 0;
  codex.readThread = async () => {
    reads += 1;
    return { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } };
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state });
  await bridge.start();
  t.after(() => bridge.stop());
  for (let i = 0; i < 20; i++) emitTopicEvent(codex, 'child', `message ${i}`);
  await tick();
  emitTopicEvent(codex, 'child', 'later message');
  await tick();
  assert.equal(reads, 1);
  assert.deepEqual(telegram.created, []);
  assert.equal(state.getTopicForThread('child'), null);
});

test('concurrent events and discovery share one pending topic creation', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  let finishCreation;
  const gate = new Promise(resolve => { finishCreation = resolve; });
  const create = telegram.createForumTopic;
  telegram.createForumTopic = async (...args) => {
    const id = await create(...args);
    await gate;
    return id;
  };
  let reads = 0;
  codex.readThread = async () => { reads += 1; return { id: 'parent', source: 'cli' }; };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state });
  await bridge.start();
  t.after(() => { finishCreation(); return bridge.stop(); });
  for (let i = 0; i < 30; i++) emitTopicEvent(codex, 'parent', `message ${i}`);
  await tick();
  codex.threads = [{ id: 'parent', source: 'cli', createdAt: Date.now() + 1000 }];
  const discovery = bridge.discoverThreads();
  await tick();
  assert.equal(reads, 1);
  assert.equal(telegram.created.length, 1);
  finishCreation();
  await discovery;
  await tick();
  assert.equal(state.getTopicForThread('parent'), 1001);
  assert.equal(telegram.created.length, 1);
  assert.equal(telegram.sent.filter(message => message.text.startsWith('Linked Codex')).length, 1);
  assert.equal(telegram.sent.filter(message => message.text.includes('message ')).length, 30);
});

test('a failed shared creation can be retried on later activity', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const create = telegram.createForumTopic;
  let attempts = 0;
  telegram.createForumTopic = async (...args) => {
    if (++attempts === 1) throw new Error('temporary failure');
    return create(...args);
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, logger: { error() {} } });
  await bridge.start();
  t.after(() => bridge.stop());
  for (let i = 0; i < 10; i++) emitTopicEvent(codex, 'parent', `first ${i}`);
  await tick();
  assert.equal(attempts, 1);
  emitTopicEvent(codex, 'parent', 'retry');
  await tick();
  assert.equal(attempts, 2);
  assert.equal(state.getTopicForThread('parent'), 1001);
});

test('session delivery recovers a missing topic after fork timeout using the latest name', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-fork-timeout-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, sessionLine('agent_message', { message: 'Old fork history' })+'\n');
  const state = memoryState();
  await state.bindChat(-10012345);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const threads = [];
  codex.listThreads = async () => threads;
  const create = telegram.createForumTopic;
  let attempts = 0;
  telegram.createForumTopic = async (...args) => {
    if (++attempts <= 2) throw new Error('Telegram createForumTopic request timed out');
    return create(...args);
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, alertChatId: '111', messageScope: 'conversation', logger: { error() {} } });
  await bridge.start();
  t.after(() => bridge.stop());
  threads.push({ id: 'fork', source: 'cli', name: 'Before rename', path: file, createdAt: Date.now()+1000, updatedAt: '1' });
  await bridge.discoverThreads();
  assert.equal(attempts, 1);
  assert.equal(state.getTopicForThread('fork'), null);
  assert.ok(telegram.sent.every(m => !m.text.includes('Make the bot an admin')));
  threads[0].name = 'After rename';
  await appendFile(file, [sessionLine('agent_message', { message: 'New fork answer' }), sessionLine('task_complete', { turn_id: 'fork-turn' })].join('\n')+'\n');
  await bridge.discoverThreads();
  assert.equal(attempts, 2);
  await bridge.discoverThreads();
  assert.equal(attempts, 3);
  assert.equal(state.getThread('fork').title, 'After rename');
  assert.equal(telegram.sent.filter(m => m.text.includes('New fork answer')).length, 1);
  assert.ok(telegram.sent.every(m => !m.text.includes('Old fork history')));
  const alerts = telegram.sent.filter(m => m.chatId === '111');
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].notify);
  assert.ok(alerts[0].text.includes('https://t.me/c/12345/1001'));
  await bridge.discoverThreads();
  assert.equal(attempts, 3);
  assert.equal(telegram.sent.filter(m => m.text.includes('New fork answer')).length, 1);
});

test('missing source metadata prevents automatic topic creation', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  codex.readThread = async () => ({ id: 'unknown' });
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state });
  await bridge.start();
  t.after(() => bridge.stop());
  emitTopicEvent(codex, 'unknown', 'hello');
  await tick();
  assert.deepEqual(telegram.created, []);
});

test('deleted welcome destination does not report a topic permissions failure or recreate', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const send = telegram.sendMessage;
  telegram.sendMessage = async message => {
    if (message.text.startsWith('Linked Codex')) throw new Error('Bad Request: message thread not found');
    return send(message);
  };
  const bridge = new CodexTelegramTopicBridge({ codex, telegram, state, logger: { error() {} } });
  await bridge.start();
  t.after(() => bridge.stop());
  emitTopicEvent(codex, 'parent', 'first');
  await tick();
  emitTopicEvent(codex, 'parent', 'second');
  await tick();
  assert.equal(telegram.created.length, 1);
  assert.equal(state.getTopicForThread('parent'), 1001);
  assert.ok(telegram.sent.every(message => !message.text.includes('Make the bot an admin')));
});

function emitTopicEvent(codex, threadId, text) {
  codex.emit('event', {
    method: 'item/agentMessage/delta', threadId,
    raw: { params: { threadId, role: 'assistant', text } },
  });
}

test('pause retains alerts and resume skips unread transcript history from the paused interval', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-stream-toggle-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, '');
  const state = memoryState();
  await state.bindChat(-10012345);
  await state.mapThread('t1',44,'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex({threads:[{id:'t1',source:'cli',path:file,title:'One'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,messageScope:'conversation',alertChatId:'111',allowedUserIds:[111111111]});
  await bridge.start();
  t.after(() => bridge.stop());
  const command = text => telegram.emit('update',{message:allowedMessage({text,chat:{id:111111111,type:'private'}})});
  command('/pause');
  await tick();
  emitTopicEvent(codex,'t1','Hidden while paused');
  codex.emit('event',{method:'turn/completed',threadId:'t1',turnId:'paused-turn',raw:{params:{}}});
  codex.emit('serverRequest',{id:9,method:'item/tool/requestUserInput',threadId:'t1',params:{questions:[{id:'q',question:'Still need your input?'}]}});
  await tick();
  assert.ok(!telegram.sent.some(m => m.text.includes('Hidden while paused')));
  assert.ok(telegram.sent.some(m => m.chatId === '111' && m.text.includes('task complete')));
  assert.ok(telegram.sent.some(m => m.text.includes('Still need your input?')));
  const oldLine = JSON.parse(sessionLine('agent_message', {message:'Unread paused history'}));
  oldLine.timestamp = '2000-01-01T00:00:00.000Z';
  await appendFile(file,JSON.stringify(oldLine)+'\n');
  command('/resume');
  await tick();
  await bridge.discoverThreads();
  assert.ok(!telegram.sent.some(m => m.text.includes('Unread paused history')));
  await appendFile(file,sessionLine('agent_message', {message:'New desktop progress'})+'\n');
  await bridge.discoverThreads();
  assert.ok(telegram.sent.some(m => m.text.includes('New desktop progress')));
});

function missingTopicError(description = 'Bad Request: message thread not found') {
  return Object.assign(new Error(description), {response:{error_code:400}});
}

test('deleted topic recovery shares one replacement across concurrent deliveries and preserves reply routing', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const send = telegram.sendMessage;
  telegram.sendMessage = async message => {
    if (message.messageThreadId === 44) throw missingTopicError();
    return send(message);
  };
  const codex = fakeCodex({threads:[{id:'t1',title:'One',source:'cli'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,allowedUserIds:[111111111]});
  await bridge.start();
  t.after(() => bridge.stop());
  emitTopicEvent(codex,'t1','First');
  emitTopicEvent(codex,'t1','Second');
  await tick();
  assert.equal(telegram.created.length,1);
  assert.equal(state.getTopicForThread('t1'),1001);
  assert.equal(state.getThreadForTopic(44),null);
  assert.ok(telegram.sent.some(m => m.messageThreadId === 1001 && m.text.includes('First')));
  assert.ok(telegram.sent.some(m => m.messageThreadId === 1001 && m.text.includes('Second')));
  telegram.emit('update',{message:allowedMessage({text:'Reply after recovery',chat:{id:-100,type:'supergroup'},is_topic_message:true,message_thread_id:1001})});
  await tick();
  assert.deepEqual(codex.sent,[{threadId:'t1',text:'Reply after recovery'}]);
});

test('AFK private completion checks deleted topic and links to its replacement', async (t) => {
  const state = memoryState();
  await state.bindChat(-10012345);
  await state.mapThread('t1',44,'One');
  const telegram = fakeTelegram();
  telegram.checkForumTopic = async (_, topic) => { if(topic === 44) throw missingTopicError('Bad Request: TOPIC_ID_INVALID'); };
  const codex = fakeCodex({threads:[{id:'t1',title:'One',source:'cli'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,messageScope:'afk',alertChatId:'111'});
  await bridge.start();
  t.after(() => bridge.stop());
  codex.emit('event',{method:'turn/completed',threadId:'t1',turnId:'turn1',raw:{params:{}}});
  await tick();
  const alert = telegram.sent.find(m => m.chatId === '111');
  assert.ok(alert.text.includes('https://t.me/c/12345/1001'));
  assert.equal(telegram.created.length,1);
});

test('completion waits for in-progress topic recovery instead of dropping its alert', async (t) => {
  const state = memoryState();
  await state.bindChat(-10012345);
  await state.mapThread('t1',44,'One');
  const telegram = fakeTelegram();
  const send = telegram.sendMessage;
  telegram.sendMessage = async message => {
    if(message.messageThreadId === 44) throw missingTopicError();
    return send(message);
  };
  let release;
  const create = telegram.createForumTopic;
  telegram.createForumTopic = async (...args) => {
    await new Promise(resolve => {release=resolve;});
    return create(...args);
  };
  const codex = fakeCodex({threads:[{id:'t1',source:'cli',title:'One'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,alertChatId:'111'});
  await bridge.start();
  t.after(() => bridge.stop());
  emitTopicEvent(codex,'t1','Answer');
  await tick();
  assert.equal(state.getTopicForThread('t1'),null);
  codex.emit('event',{method:'turn/completed',threadId:'t1',turnId:'finished',raw:{params:{}}});
  await tick();
  release();
  await tick();
  assert.equal(telegram.created.length,1);
  assert.ok(telegram.sent.some(m => m.chatId === '111' && m.text.includes('/12345/1001')));
});

test('topic recovery does not replace destinations for network, permission, rate limit, or closed-topic errors', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1',44,'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex({threads:[{id:'t1',source:'cli'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,logger:{error(){}}});
  await bridge.start();
  t.after(() => bridge.stop());
  for (const [code, description] of [[undefined,'network timeout'],[403,'Forbidden'],[429,'Too Many Requests'],[400,'TOPIC_CLOSED'],[400,'chat not found']]) {
    telegram.sendMessage = async () => {throw Object.assign(new Error(description),{response:{error_code:code}});};
    emitTopicEvent(codex,'t1',description);
    await tick();
    assert.equal(state.getTopicForThread('t1'),44);
  }
  assert.equal(telegram.created.length,0);
});

test('topic recovery retries a delivery only once when the replacement also disappears', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1',44,'One');
  const telegram = fakeTelegram();
  telegram.sendMessage = async () => {throw missingTopicError('Bad Request: TOPIC_DELETED');};
  const codex = fakeCodex({threads:[{id:'t1',source:'cli'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state,logger:{error(){}}});
  await bridge.start();
  t.after(() => bridge.stop());
  emitTopicEvent(codex,'t1','Answer');
  await tick();
  assert.equal(telegram.created.length,1);
  assert.ok(state.data.lastErrors.length > 0);
});

test('rename recovers a deleted Telegram topic and updates the replacement title', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1',44,'One');
  const telegram = fakeTelegram();
  const edit = telegram.editForumTopic;
  telegram.editForumTopic = async (chat,topic,title) => {
    if(topic === 44) throw missingTopicError('Bad Request: TOPIC_ID_INVALID');
    return edit(chat,topic,title);
  };
  const codex = fakeCodex({threads:[{id:'t1',title:'One',source:'cli'}]});
  const bridge = new CodexTelegramTopicBridge({codex,telegram,state});
  await bridge.start();
  t.after(() => bridge.stop());
  codex.emit('event',{method:'thread/name/updated',threadId:'t1',raw:{params:{threadName:'New name'}}});
  await tick();
  assert.equal(state.getTopicForThread('t1'),1001);
  assert.equal(state.getThread('t1').title,'New name');
  assert.equal(telegram.edited.at(-1).messageThreadId,1001);
});

test('streaming includes both desktop and Telegram turns and preserves attention requests', async (t) => {
  const state = memoryState();
  await state.bindChat(-100);
  await state.mapThread('t1', 44, 'One');
  const telegram = fakeTelegram();
  const codex = fakeCodex({ threads: [{id:'t1', source:'cli', title:'One'}] });
  const bridge = new CodexTelegramTopicBridge({codex, telegram, state, messageScope:'afk', alertChatId:'111111111', allowedUserIds:[111111111]});
  await bridge.start();
  t.after(() => bridge.stop());
  const answer = (turnId, text) => codex.emit('event', {method:'item/completed', threadId:'t1', turnId,
    raw:{params:{item:{id:text, type:'agentMessage', text}}}});
  answer('desktop', 'Desktop answer');
  codex.emit('event', {method:'turn/completed',threadId:'t1',turnId:'desktop',raw:{params:{}}});
  await tick();
  assert.ok(telegram.sent.some(m => m.text.includes('Desktop answer')));
  assert.equal(telegram.sent.filter(m => m.notify).length, 1);
  codex.sendToThread = async (threadId, text) => {
    codex.sent.push({threadId, text});
    codex.emit('event', {method:'turn/started',threadId,turnId:'remote',raw:{params:{}}});
    answer('remote', 'Immediate remote answer');
    return {turn:{id:'remote'}};
  };
  telegram.emit('update', {message:allowedMessage({text:'Continue remotely',chat:{id:-100,type:'supergroup'},is_topic_message:true,message_thread_id:44})});
  await tick();
  assert.deepEqual(codex.sent, [{threadId:'t1',text:'Continue remotely'}]);
  assert.ok(telegram.sent.some(m => m.text.includes('Immediate remote answer')));
  answer('remote', 'Remote final');
  answer('desktop-next', 'Next desktop answer');
  codex.emit('serverRequest', {id:9,method:'item/tool/requestUserInput',threadId:'t1',params:{questions:[{id:'q',question:'Which option?'}]}});
  await tick();
  assert.ok(telegram.sent.some(m => m.text.includes('Remote final')));
  assert.ok(telegram.sent.some(m => m.text.includes('Next desktop answer')));
  assert.ok(telegram.sent.some(m => m.text.includes('Which option?')));
});

test('discovery skips history and session tail forwards both desktop and Telegram turns', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-afk-'));
  const file = join(dir, 'session.jsonl');
  await writeFile(file, sessionLine('agent_message', {message:'Old history'})+'\n'+sessionLine('task_complete',{turn_id:'old'})+'\n');
  const state = memoryState();
  await state.bindChat(-100);
  const telegram = fakeTelegram();
  const codex = fakeCodex();
  const bridge = new CodexTelegramTopicBridge({codex, telegram, state, messageScope:'afk', allowedUserIds:[111111111]});
  await bridge.start();
  t.after(() => bridge.stop());
  codex.threads = [{id:'t1',source:'cli',title:'One',path:file,createdAt:Date.now()+1000}];
  await bridge.discoverThreads();
  assert.ok(!telegram.sent.some(m => /Old history|task complete/.test(m.text)));
  codex.sendToThread = async () => ({turn:{id:'remote'}});
  telegram.emit('update', {message:allowedMessage({text:'Continue',chat:{id:-100,type:'supergroup'},is_topic_message:true,message_thread_id:1001})});
  await tick();
  await appendFile(file, [sessionLine('task_started',{turn_id:'desktop'}),sessionLine('agent_message', {message:'Desktop log'}),
    sessionLine('task_started',{turn_id:'remote'}),sessionLine('agent_message', {message:'Remote log'}),sessionLine('task_complete',{turn_id:'remote'})].join('\n')+'\n');
  await bridge.discoverThreads();
  assert.ok(telegram.sent.some(m => m.text.includes('Desktop log')));
  assert.ok(telegram.sent.some(m => m.text.includes('Remote log')));
  assert.equal(telegram.sent.filter(m => m.notify).length, 1);
});
