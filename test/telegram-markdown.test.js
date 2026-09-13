import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTelegramMarkdown } from '../src/telegram-markdown.js';
import { TelegramClient } from '../src/telegram.js';

test('renders headings, inline styles, links and literal HTML safely', () => {
  const [{html,text}] = renderTelegramMarkdown('# Heading\n\n**bold** and *italic* and ~~gone~~ [link](https://example.com/?x=1&y=2) `<tag>` <script>');
  assert.match(html, /<b>Heading<\/b>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<i>italic<\/i>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /href="https:\/\/example.com\/\?x=1&amp;y=2"/);
  assert.match(html, /<code>&lt;tag&gt;<\/code>/);
  assert.ok(!html.includes('<script>'));
  assert.ok(text.includes('<script>'));
});

test('long code preserves every character and reopens tags in each chunk', () => {
  const code = '<&😀>'.repeat(1400) + '\n';
  const chunks = renderTelegramMarkdown('```python\n'+code+'```');
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(c=>c.text).join(''),code);
  for(const c of chunks) {
    assert.ok(c.text.length <= 3900);
    assert.ok(c.text.isWellFormed());
    assert.match(c.html,/^<pre><code class="language-python">/);
    assert.match(c.html,/<\/code><\/pre>$/);
  }
});

test('split bold spans remain balanced', () => {
  const chunks=renderTelegramMarkdown('**'+'x'.repeat(4100)+'**');
  assert.equal(chunks.map(c=>c.text).join(''),'x'.repeat(4100));
  assert.ok(chunks.every(c=>/^<b>x+<\/b>$/.test(c.html)));
});

test('tables use literal code and ordered lists retain their starting number', () => {
  const [{html}]=renderTelegramMarkdown('| a | b |\n|---|---|\n| x | y |\n\n3. third\n4. fourth');
  assert.match(html,/<pre>\| a \| b \|/);
  assert.ok(html.includes('3. '));
  assert.ok(html.includes('4. '));
  assert.ok(!html.includes('<table>'));
});

test('nested quotes do not emit nested blockquote tags and unfinished fences close', () => {
  const [{html}]=renderTelegramMarkdown('> > **quoted**\n\n```js\nconst x = 1;');
  assert.ok(!html.includes('<blockquote><blockquote>'));
  assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>$/);
});

function mockClient(respond) {
 const calls=[];
 const client=new TelegramClient({token:'test',fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body});
  return respond?.(calls.length) ?? {ok:true,json:async()=>({ok:true,result:{message_id:calls.length}})};
 }});
 return {client,calls};
}

test('final stream edits retain formatting across overflow messages in the same topic', async () => {
 const {client,calls}=mockClient();
 await client.editMessageText({chatId:-1,messageId:10,messageThreadId:22,text:'**'+'x'.repeat(4100)+'**'});
 assert.equal(calls.length,2);
 assert.match(calls[0].url,/editMessageText$/);
 assert.match(calls[1].url,/sendMessage$/);
 assert.equal(calls[1].body.message_thread_id,22);
 assert.equal(calls[1].body.disable_notification,true);
 assert.ok(calls.every(c=>c.body.parse_mode==='HTML' && /^<b>x+<\/b>$/.test(c.body.text)));
});

test('formatting rejection falls back to the rendered plain text', async () => {
 const {client,calls}=mockClient(n=> n===1 ? {ok:false,json:async()=>({ok:false,error_code:400,description:"Bad Request: can't parse entities"})}:null);
 await client.sendMessage({chatId:-1,text:'**bold**'});
 assert.equal(calls.length,2);
 assert.equal(calls[1].body.text,'bold');
 assert.equal(calls[1].body.parse_mode,undefined);
});

test('non-formatting errors propagate without retrying delivery', async () => {
 const {client,calls}=mockClient(()=>({ok:false,json:async()=>({ok:false,error_code:403,description:'Forbidden'})}));
 await assert.rejects(client.sendMessage({chatId:-1,text:'**bold**'}),/Forbidden/);
 assert.equal(calls.length,1);
});


test('messages default to silent, explicit alerts notify only on the first Markdown chunk', async () => {
 const {client,calls}=mockClient();
 await client.sendMessage({chatId:-1,text:'**Progress**'});
 assert.equal(calls[0].body.disable_notification,true);
 await client.sendMessage({chatId:-1,text:'**'+'x'.repeat(4100)+'**',notify:true});
 assert.equal(calls[1].body.disable_notification,false);
 assert.equal(calls[2].body.disable_notification,true);
});

test('formatting fallback preserves the notification setting', async () => {
 const {client,calls}=mockClient(n=>n===1?{ok:false,json:async()=>({ok:false,error_code:400,description:"Bad Request: can't parse entities"})}:null);
 await client.sendMessage({chatId:-1,text:'**Input needed**',notify:true});
 assert.equal(calls.length,2);
 assert.ok(calls.every(call=>call.body.disable_notification===false));
});
