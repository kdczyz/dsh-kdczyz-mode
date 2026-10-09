import { DsmlBridge } from '../dsh-wotr-console/vendor/xdpool/lib/dsml-bridge.mjs';

const BAR = '\uFF5C';
const T = BAR + 'DSML' + BAR;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + extra)); }
}

function sse(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function contentFrame(text) {
  return sse({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}
function finishFrame(reason) {
  return sse({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

function run(bridge, raw) {
  return raw.split('').map((c) => bridge.push(c)).join('') + bridge.end();
}

function collect(outText) {
  const text = [];
  const calls = [];
  let finish = null;
  for (const frame of outText.split('\n\n')) {
    const line = frame.trim();
    if (line === '' || line === 'data: [DONE]') continue;
    if (!line.startsWith('data:')) continue;
    let p;
    try { p = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const ch = p.choices && p.choices[0];
    if (!ch) continue;
    if (ch.delta && typeof ch.delta.content === 'string') text.push(ch.delta.content);
    if (ch.delta && Array.isArray(ch.delta.tool_calls)) { for (const c of ch.delta.tool_calls) calls.push(c); }
    if (ch.finish_reason != null) finish = ch.finish_reason;
  }
  return { text: text.join(''), calls, finish };
}

// 1. plain text passes through untouched
{
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, contentFrame('Hello ') + contentFrame('world') + finishFrame('stop') + 'data: [DONE]\n\n');
  const r = collect(out);
  console.log('1. plain text');
  ok('text preserved', r.text === 'Hello world', JSON.stringify(r.text));
  ok('no tool calls', r.calls.length === 0);
  ok('finish stop kept', r.finish === 'stop', String(r.finish));
  ok('done marker kept', out.includes('data: [DONE]'));
}

// 2. DSML split character by character
{
  const dsml = '<' + T + 'tool_calls>\n<' + T + 'invoke name="bash">\n<' + T + 'parameter name="command" string="true">echo DSH_TOOL_OK</' + T + 'parameter>\n</' + T + 'invoke>\n</' + T + 'tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, contentFrame(dsml) + finishFrame('stop') + 'data: [DONE]\n\n');
  const r = collect(out);
  console.log('2. DSML, 1 char per frame');
  ok('one tool call', r.calls.length === 1, String(r.calls.length));
  ok('name bash', r.calls[0] && r.calls[0].function.name === 'bash', JSON.stringify(r.calls[0]));
  ok('arguments', r.calls[0] && JSON.parse(r.calls[0].function.arguments).command === 'echo DSH_TOOL_OK', r.calls[0] && r.calls[0].function.arguments);
  ok('markup not leaked as text', r.text.indexOf('DSML') === -1, JSON.stringify(r.text.slice(0, 80)));
  ok('finish rewritten', r.finish === 'tool_calls', String(r.finish));
}

// 3. prose before and after the block
{
  const dsml = '<' + T + 'tool_calls><' + T + 'invoke name="read"><' + T + 'parameter name="file_path" string="true">/tmp/a.txt</' + T + 'parameter></' + T + 'invoke></' + T + 'tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, contentFrame('Let me look. ') + contentFrame(dsml) + contentFrame(' Done.') + finishFrame('stop') + 'data: [DONE]\n\n');
  const r = collect(out);
  console.log('3. prose around block');
  ok('keeps prose', r.text.replace(/\s+/g, ' ').trim() === 'Let me look. Done.', JSON.stringify(r.text));
  ok('one tool call', r.calls.length === 1, String(r.calls.length));
  ok('name read', r.calls[0] && r.calls[0].function.name === 'read');
  ok('file_path parsed', r.calls[0] && JSON.parse(r.calls[0].function.arguments).file_path === '/tmp/a.txt');
}

// 4. several invokes in one block
{
  const dsml = '<' + T + 'tool_calls><' + T + 'invoke name="bash"><' + T + 'parameter name="command" string="true">ls</' + T + 'parameter></' + T + 'invoke><' + T + 'invoke name="bash"><' + T + 'parameter name="command" string="true">pwd</' + T + 'parameter></' + T + 'invoke></' + T + 'tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(dsml) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('4. multiple invokes');
  ok('two calls', r.calls.length === 2, String(r.calls.length));
  ok('distinct indexes', r.calls.length === 2 && r.calls[0].index === 0 && r.calls[1].index === 1);
  ok('second is pwd', r.calls[1] && JSON.parse(r.calls[1].function.arguments).command === 'pwd');
}

// 5. kimi dialect
{
  const text = '<tool>bash</tool> <parameter>{"command":"echo hi"}</parameter>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(text) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('5. kimi dialect');
  ok('one call', r.calls.length === 1, String(r.calls.length));
  ok('name bash', r.calls[0] && r.calls[0].function.name === 'bash', JSON.stringify(r.calls[0]));
  ok('args json', r.calls[0] && JSON.parse(r.calls[0].function.arguments).command === 'echo hi', r.calls[0] && r.calls[0].function.arguments);
  ok('no leak', r.text.indexOf('<parameter>') === -1, JSON.stringify(r.text));
}

// 6. hy3 dialect
{
  const text = '<tool_calls:6124c78e> <tool_call:6124c78e>bash <tool_call:6124c78e>command echo DSH_TOOL_OK </tool_call:6124c78e> </tool_calls:6124c78e>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(text) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('6. hy3 dialect');
  ok('one call', r.calls.length === 1, String(r.calls.length));
  ok('name bash', r.calls[0] && r.calls[0].function.name === 'bash', JSON.stringify(r.calls[0]));
  ok('args', r.calls[0] && JSON.parse(r.calls[0].function.arguments).command === 'echo DSH_TOOL_OK', r.calls[0] && r.calls[0].function.arguments);
}

// 7. truncated block at end of stream (no close tag)
{
  const text = 'ok <' + T + 'tool_calls><' + T + 'invoke name="bash"><' + T + 'parameter name="command" string="true">ls -la</' + T + 'parameter></' + T + 'invoke>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(text) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('7. truncated block');
  ok('best-effort call', r.calls.length === 1, String(r.calls.length));
  ok('name bash', r.calls[0] && r.calls[0].function.name === 'bash', JSON.stringify(r.calls[0]));
}

// 8. non-content frames survive
{
  const usage = sse({ id: 'x', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, contentFrame('hi') + usage + finishFrame('stop') + 'data: [DONE]\n\n');
  console.log('8. other frames');
  ok('usage frame kept', out.includes('prompt_tokens'), out.slice(0, 200));
}

// 9. hostile input must not throw
{
  const b = new DsmlBridge({ model: 'm' });
  let threw = null;
  try { run(b, 'data: not json\n\n' + contentFrame('<') + contentFrame('broken') + 'garbage'); } catch (e) { threw = String(e); }
  console.log('9. hostile input');
  ok('does not throw', threw === null, String(threw));
}

// 10. the doubled-bar spelling captured from the real WorkBuddy stream
{
  const T2 = BAR + BAR + 'DSML' + BAR + BAR;
  const text = '<' + T2 + 'tool_calls>\n<' + T2 + 'invoke name="bash">\n<' + T2 + 'parameter name="command" string="true">echo hi</' + T2 + 'parameter>\n</' + T2 + 'invoke>\n</' + T2 + 'tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(text) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('10. doubled-bar DSML (full width)');
  ok('one call', r.calls.length === 1, String(r.calls.length));
  ok('name bash', r.calls[0] && r.calls[0].function.name === 'bash', JSON.stringify(r.calls[0]));
  ok('args', r.calls[0] && JSON.parse(r.calls[0].function.arguments).command === 'echo hi', r.calls[0] && r.calls[0].function.arguments);
}

// 11. ascii doubled bars
{
  const text = '<||DSML||tool_calls><||DSML||invoke name="write"><||DSML||parameter name="file_path" string="true">/tmp/x</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(text) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('11. doubled-bar DSML (ascii)');
  ok('one call', r.calls.length === 1, String(r.calls.length));
  ok('name write', r.calls[0] && r.calls[0].function.name === 'write', JSON.stringify(r.calls[0]));
}

// 12. bare tool_calls tag
{
  const text = '<tool_calls><invoke name="bash"><parameter name="command" string="true">pwd</parameter></invoke></tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const r = collect(run(b, contentFrame(text) + finishFrame('stop') + 'data: [DONE]\n\n'));
  console.log('12. bare tool_calls tag');
  ok('one call', r.calls.length === 1, String(r.calls.length));
  ok('name bash', r.calls[0] && r.calls[0].function.name === 'bash', JSON.stringify(r.calls[0]));
}

// 13. multi-frame chunking (realistic network splits) keeps everything
{
  const dsml = 'Sure! <' + T + 'tool_calls><' + T + 'invoke name="bash"><' + T + 'parameter name="command" string="true">ls -la /tmp</' + T + 'parameter></' + T + 'invoke></' + T + 'tool_calls> all done';
  const b = new DsmlBridge({ model: 'm' });
  let out = '';
  for (let i = 0; i < dsml.length; i += 7) out += b.push(contentFrame(dsml.slice(i, i + 7)));
  out += b.push(finishFrame('stop') + 'data: [DONE]\n\n') + b.end();
  const r = collect(out);
  console.log('13. 7-char chunks with prose');
  ok('one call', r.calls.length === 1, String(r.calls.length));
  ok('args complete', r.calls[0] && JSON.parse(r.calls[0].function.arguments).command === 'ls -la /tmp', r.calls[0] && r.calls[0].function.arguments);
  ok('prose kept', r.text.replace(/\s+/g, ' ').trim() === 'Sure! all done', JSON.stringify(r.text));
}

// 14. the gateway's real frame shape: finish_reason "" on every frame
{
  const gw = (text, reason) => sse({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: text, reasoning_content: '', tool_calls: [] }, finish_reason: reason }] });
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, gw('The', '') + gw(' sea', '') + gw(' is', '') + gw(' calm', '') + gw('', 'stop') + 'data: [DONE]\n\n');
  const r = collect(out);
  console.log('14. gateway frame shape (finish_reason "")');
  ok('text NOT duplicated', r.text === 'The sea is calm', JSON.stringify(r.text));
  ok('finish stop kept', r.finish === 'stop', String(r.finish));
}

// 15. content and a real finish_reason in the same frame
{
  const both = sse({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'bye' }, finish_reason: 'stop' }] });
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, contentFrame('hi ') + both + 'data: [DONE]\n\n');
  const r = collect(out);
  console.log('15. content + finish in one frame');
  ok('text not duplicated', r.text === 'hi bye', JSON.stringify(r.text));
  ok('finish kept', r.finish === 'stop', String(r.finish));
}

// 16. DSML block with the gateway frame shape
{
  const gw = (text) => sse({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: text, tool_calls: [] }, finish_reason: '' }] });
  const dsml = 'ok <' + T + 'tool_calls><' + T + 'invoke name="bash"><' + T + 'parameter name="command" string="true">ls</' + T + 'parameter></' + T + 'invoke></' + T + 'tool_calls>';
  const b = new DsmlBridge({ model: 'm' });
  const out = run(b, gw(dsml) + sse({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  const r = collect(out);
  console.log('16. DSML + gateway frame shape');
  ok('one tool call', r.calls.length === 1, String(r.calls.length));
  ok('prose kept once', r.text.replace(/\s+/g, ' ').trim() === 'ok', JSON.stringify(r.text));
  ok('finish is tool_calls', r.finish === 'tool_calls', String(r.finish));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
