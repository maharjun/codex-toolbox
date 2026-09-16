import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { launcherEnv, localPaths, parseAppServerArgs, proxyEndpoint } from '../src/local-runtime.js';

test('platform paths preserve Linux installs and support Windows homes containing spaces', () => {
  assert.deepEqual(localPaths({platform:'linux',home:'/home/test',env:{}}), {
    config:'/home/test/.config/codex-toolbox/config.json',state:'/home/test/.local/state/codex-toolbox/state.json',
  });
  assert.deepEqual(localPaths({platform:'win32',home:'C:\\Users\\Test User',env:{}}), {
    config:'C:\\Users\\Test User\\AppData\\Local\\codex-toolbox\\config.json',
    state:'C:\\Users\\Test User\\AppData\\Local\\codex-toolbox\\state.json',
  });
  assert.deepEqual(localPaths({platform:'win32',home:'C:\\Users\\Test',env:{CODEX_TOOLBOX_CONFIG:'D:\\config.json',CODEX_TOOLBOX_STATE:'D:\\state.json'}}), {
    config:'D:\\config.json',state:'D:\\state.json',
  });
});

test('launcher preserves proxy argument boundaries and consumes a token without mutating its input', () => {
  const env={TELEGRAM_BOT_API_KEY:'synthetic-test-token'};
  const proxyPath='C:\\Program Files\\Toolbox\\bin\\local-codex-proxy.js';
  const result=launcherEnv({userId:123,cwd:'C:\\Work Projects',codexEndpoint:'ws://127.0.0.1:4600'}, {
    env,platform:'win32',home:'C:\\Users\\Test',execPath:'C:\\Program Files\\nodejs\\node.exe',proxyPath,
  });
  assert.equal(result.TELEGRAM_BOT_TOKEN,env.TELEGRAM_BOT_API_KEY);
  assert.equal(result.TELEGRAM_ALERT_CHAT_ID,'123');
  assert.equal(env.TELEGRAM_BOT_TOKEN,undefined);
  assert.deepEqual(parseAppServerArgs(result),[proxyPath]);
  assert.equal(result.CODEX_APP_SERVER_COMMAND,'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(result.CODEX_APP_SERVER_URL,'ws://127.0.0.1:4600');
  assert.equal(result.CODEX_TELEGRAM_MESSAGE_SCOPE,'afk');
});

test('invalid config and arguments fail without reflecting supplied values', () => {
  assert.throws(()=>launcherEnv({}, {env:{}}),/Activate/);
  assert.throws(()=>launcherEnv({userId:'bad',cwd:'relative'}, {env:{TELEGRAM_BOT_API_KEY:'test'}}),/numeric userId/);
  for (const value of ['broken','[123]','{}']) assert.throws(()=>parseAppServerArgs({CODEX_APP_SERVER_ARGS_JSON:value}),/JSON string array/);
  assert.deepEqual(parseAppServerArgs({CODEX_APP_SERVER_ARGS:'app-server "two words"'}),['app-server','two words']);
});

test('portable launcher permits opting back into conversation mirroring', () => {
  const result = launcherEnv({userId:123,cwd:'C:\\Work'}, {
    env:{TELEGRAM_BOT_API_KEY:'synthetic',CODEX_TELEGRAM_MESSAGE_SCOPE:'conversation'},
    platform:'win32',proxyPath:'C:\\proxy.js',
  });
  assert.equal(result.CODEX_TELEGRAM_MESSAGE_SCOPE,'conversation');
});

test('proxy selects platform transport and validates network endpoints', () => {
  assert.equal(proxyEndpoint({platform:'win32',env:{}}),'ws://127.0.0.1:4500/');
  assert.equal(proxyEndpoint({platform:'linux',home:'/home/test',env:{}}),'ws+unix:///home/test/.codex/app-server-control/app-server-control.sock:/rpc');
  assert.equal(proxyEndpoint({platform:'linux',env:{CODEX_CONTROL_SOCKET:'/tmp/custom.sock'}}),'ws+unix:///tmp/custom.sock:/rpc');
  assert.equal(proxyEndpoint({env:{CODEX_APP_SERVER_URL:'wss://example.com/rpc'}}),'wss://example.com/rpc');
  for(const url of ['not a url','http://localhost','ws://example.com','ws://user:password@localhost']) {
    assert.throws(()=>proxyEndpoint({env:{CODEX_APP_SERVER_URL:url}}));
  }
});

test('real proxy relays JSONL bidirectionally over TCP without compression', {timeout:5000}, async t => {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  t.after(()=>server.close());
  await once(server,'listening');
  let extensions;
  server.on('connection',(ws,request)=>{
    extensions=request.headers['sec-websocket-extensions'];
    t.after(()=>ws.terminate());
    ws.on('message',data=>{
      const message=JSON.parse(data);
      ws.send(JSON.stringify({id:message.id,result:{echo:message.params.text}}));
    });
  });
  const child=spawn(process.execPath,[fileURLToPath(new URL('../bin/local-codex-proxy.js',import.meta.url))],{
    env:{CODEX_APP_SERVER_URL:`ws://127.0.0.1:${server.address().port}`},stdio:['pipe','pipe','pipe'],
  });
  t.after(()=>child.kill());
  const lines=createInterface({input:child.stdout});
  t.after(()=>lines.close());
  // Send before the WebSocket opens to exercise the startup queue.
  const reply=once(lines,'line');
  child.stdin.write(JSON.stringify({id:1,params:{text:'Hello **Markdown** 😀'}})+'\n');
  assert.deepEqual(JSON.parse((await reply)[0]),{id:1,result:{echo:'Hello **Markdown** 😀'}});
  assert.equal(extensions,undefined);
});
