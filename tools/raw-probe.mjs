/**
 * Same as probe2 but with a unique nonce each time, so no gateway cache.
 */
const mod = await import(
  '../archive-workbuddy/vendor/xdpool/lib/index.js'
);
const pool = new mod.WorkBuddyAccountPool({});
await pool.scan();
const client = new mod.WorkBuddyUpstreamClient();
const account = await pool.acquire('deepseek-v4.1-flash');

async function one(label, nonce, withTools) {
  const body = {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: 'You are a coding agent. Nonce for this request: ' + nonce },
      { role: 'user', content: 'Reply with exactly this sentence: the quick brown fox jumps over the lazy dog ' + nonce }
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 200,
    temperature: 1
  };
  if (withTools) {
    body.tools = [{
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }
    }];
    body.tool_choice = 'auto';
  }
  const prepared = client.prepareChatBody(JSON.stringify(body));
  const result = await client.chatStream(account.credential, prepared);
  if (!result.ok) { console.log(label, 'REFUSED', result.kind, result.status); return; }
  const raw = await result.response.text();
  const contents = [];
  let dup = 0;
  let toolCalls = 0;
  let finish = null;
  for (const f of raw.split('\n\n')) {
    const line = f.trim();
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (p === '[DONE]' || p === '') continue;
    let parsed;
    try { parsed = JSON.parse(p); } catch { continue; }
    const ch = parsed.choices && parsed.choices[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (typeof d.content === 'string' && d.content !== '') {
      if (contents.length > 0 && contents[contents.length - 1] === d.content) dup += 1;
      contents.push(d.content);
    }
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) toolCalls += 1;
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const text = contents.join('');
  console.log('\n== ' + label + ' ==');
  console.log('bytes:', raw.length, '| content frames:', contents.length, '| adjacent dups:', dup);
  console.log('text:', JSON.stringify(text.slice(0, 260)));
  console.log('tool_call deltas:', toolCalls, '| finish:', JSON.stringify(finish));
}

const nonce = 'N' + Math.random().toString(36).slice(2, 10).toUpperCase();
await one('unique prompt, no tools', nonce + 'A', false);
await one('unique prompt, with tools', nonce + 'B', true);
