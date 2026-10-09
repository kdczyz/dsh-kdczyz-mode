/**
 * dsml-bridge: turn leaked tool-call MARKUP into real OpenAI tool_calls.
 *
 * Why this exists
 * ---------------
 * The WorkBuddy gateway does not convert the model's tool calls into
 * OpenAI `tool_calls`. Instead the raw markup ends up inside
 * `choices[0].delta.content`, so DSH renders it as plain text and the
 * tool is never executed. The pool used to forward upstream bytes
 * verbatim (`body.pipe(res)`), so nothing could fix that downstream.
 *
 * This module sits between the upstream SSE stream and the client:
 * it buffers assistant text, detects the markup dialects we have seen in
 * the wild, and rewrites a matching block into `delta.tool_calls` frames.
 *
 * Dialects handled
 * ----------------
 *   A. DeepSeek DSML (the common one), BAR = U+FF5C:
 *        <BAR DSML BAR tool_calls>
 *          <BAR DSML BAR invoke name="bash">
 *            <BAR DSML BAR parameter name="command" string="true">echo hi</BAR DSML BAR parameter>
 *          </BAR DSML BAR invoke>
 *        </BAR DSML BAR tool_calls>
 *      ASCII-pipe spellings (<|DSML|tool_calls>) are accepted too.
 *   B. Kimi-style:  <tool>bash</tool> <parameter>{"command":"echo hi"}</parameter>
 *   C. Hy3-style:   <tool_calls:ID> <tool_call:ID>bash <tool_call:ID>command echo hi </tool_call:ID> </tool_calls:ID>
 *
 * Safety
 * ------
 * This is a best-effort rewriter that never throws: any parse failure
 * falls back to emitting the original text, so a wrong guess cannot
 * corrupt or truncate a stream, and plain conversations pass through
 * byte-identical (only the frame is re-serialised when we touched it).
 */

const FULLWIDTH_BAR = '\uFF5C';
const DSML_TAG = FULLWIDTH_BAR + 'DSML' + FULLWIDTH_BAR;

/** Open/close markers per dialect. `open`/`close` are literal or RegExp. */
const BLOCKS = [
  {
    name: 'dsml',
    // Both the single-bar (<BAR DSML BAR tool_calls>) and the doubled-bar
    // spelling seen in the wild, with ASCII pipes or U+FF5C.
    open: /<[|\uFF5C]{1,2}DSML[|\uFF5C]{1,2}tool_calls>/,
    close: /<\/[|\uFF5C]{1,2}DSML[|\uFF5C]{1,2}tool_calls>/
  },
  {
    name: 'dsml-loose',
    open: /<[|\uFF5C]{0,2}tool_calls[|\uFF5C]{0,2}>/,
    close: /<\/[|\uFF5C]{0,2}tool_calls[|\uFF5C]{0,2}>/
  },
  {
    name: 'hy3',
    open: /<tool_calls:[0-9a-fA-F]+>/,
    close: /<\/tool_calls:[0-9a-fA-F]+>/
  },
  {
    name: 'kimi',
    open: '<tool>',
    close: '</parameter>'
  }
];

const MAX_HOLD = 512 * 1024;
const TAG_TAIL = 40;

/** Longest suffix of `text` that could still grow into `marker`. */
function partialTail(text, marker) {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

function partialReTail(text, re) {
  const src = re.source.replace(/^\^/, '');
  const head = src.slice(0, Math.min(src.length, 24));
  for (let n = Math.min(text.length, head.length - 1); n > 0; n -= 1) {
    if (text.endsWith(head.slice(0, n))) return n;
  }
  return 0;
}

/** How much of a trailing partial CLOSE marker must be held back. */
function holdClose(text, marker) {
  if (typeof marker === 'string') return partialTail(text, marker);
  const at = text.lastIndexOf('<');
  return at !== -1 && text.length - at <= TAG_TAIL ? text.length - at : 0;
}

/** How many trailing chars must be held back before a marker can be decided. */
function holdBack(text) {
  let hold = 0;
  for (const block of BLOCKS) {
    if (typeof block.open === 'string') hold = Math.max(hold, partialTail(text, block.open));
    else hold = Math.max(hold, partialReTail(text, block.open));
  }
  const at = text.lastIndexOf('<');
  if (at !== -1 && text.length - at <= TAG_TAIL) hold = Math.max(hold, text.length - at);
  return hold;
}

function matchOpen(text) {
  let best = null;
  for (const block of BLOCKS) {
    let at = -1;
    let len = 0;
    if (typeof block.open === 'string') {
      at = text.indexOf(block.open);
      len = block.open.length;
    } else {
      const m = block.open.exec(text);
      if (m !== null) { at = m.index; len = m[0].length; }
    }
    if (at === -1) continue;
    if (best === null || at < best.at) best = { at, len, block };
  }
  return best;
}

function matchClose(text, block) {
  if (typeof block.close === 'string') {
    const at = text.indexOf(block.close);
    return at === -1 ? null : { at, len: block.close.length };
  }
  const m = block.close.exec(text);
  return m === null ? null : { at: m.index, len: m[0].length };
}

function coerce(raw, attrs) {
  const trimmed = raw.trim();
  if (/string\s*=\s*"true"/i.test(attrs)) return trimmed;
  if (trimmed === '') return '';
  if (/^(true|false)$/.test(trimmed)) return trimmed === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[[{]/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  return trimmed;
}

function parseInvokeBody(body) {
  const params = {};
  const re = /<[^<>]*parameter\s+name="([^"]*)"([^<>]*)>([\s\S]*?)<\/[^<>]*parameter>/g;
  let m;
  let found = false;
  while ((m = re.exec(body)) !== null) {
    found = true;
    params[m[1]] = coerce(m[3], m[2]);
  }
  if (found) return params;
  const trimmed = body.trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { input: parsed };
  } catch {
    return { input: trimmed };
  }
}

function parseDsml(inner) {
  const calls = [];
  const re = /<[^<>]*invoke\s+name="([^"]*)"[^<>]*>([\s\S]*?)<\/[^<>]*invoke>/g;
  let m;
  while ((m = re.exec(inner)) !== null) calls.push({ name: m[1], arguments: JSON.stringify(parseInvokeBody(m[2])) });
  if (calls.length === 0) {
    const loose = /name="([^"]*)"/.exec(inner);
    if (loose !== null && inner.indexOf('invoke') !== -1) {
      calls.push({ name: loose[1], arguments: JSON.stringify(parseInvokeBody(inner)) });
    }
  }
  return calls;
}

function parseHy3(inner) {
  const parts = inner
    .split(/<tool_call:[0-9a-fA-F]+>/)
    .map((s) => s.replace(/<\/tool_call:[0-9a-fA-F]+>/g, '').trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return [];
  const name = parts[0].replace(/[^A-Za-z0-9_.-]/g, '');
  if (name === '') return [];
  const params = {};
  for (const part of parts.slice(1)) {
    const sp = part.search(/\s/);
    if (sp === -1) params[part] = '';
    else params[part.slice(0, sp)] = coerce(part.slice(sp + 1), '');
  }
  return [{ name, arguments: JSON.stringify(params) }];
}

function parseKimi(inner) {
  // `inner` starts right after the `<tool>` open marker, so the name comes
  // first; the `<tool>` spelling is also accepted in case it was not eaten.
  const m = /^\s*(?:<tool>)?\s*([A-Za-z0-9_.-]+)\s*<\/tool>([\s\S]*)/.exec(inner) ||
    /<tool>\s*([A-Za-z0-9_.-]+)\s*<\/tool>([\s\S]*)/.exec(inner);
  if (m === null) return [];
  const name = m[1];
  const pm = /<parameter>\s*([\s\S]*?)(?:<\/parameter>|$)/.exec(m[2]);
  if (pm === null) return [{ name, arguments: '{}' }];
  const raw = pm[1].trim();
  if (raw === '') return [{ name, arguments: '{}' }];
  try { JSON.parse(raw); return [{ name, arguments: raw }]; } catch { /* not json */ }
  return [{ name, arguments: JSON.stringify({ input: raw }) }];
}

function parseBlock(block, inner) {
  if (block.name === 'hy3') return parseHy3(inner);
  if (block.name === 'kimi') return parseKimi(inner);
  return parseDsml(inner);
}

function makeId() {
  return 'call_' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
}

function chunkBase(model, extra) {
  return {
    id: 'chatcmpl-wbdsml',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    ...(model === undefined ? {} : { model }),
    ...extra
  };
}

/**
 * Streaming rewriter. Feed raw upstream text, forward what it returns.
 *
 *   const bridge = new DsmlBridge({ model });
 *   out += bridge.push(rawChunk);
 *   out += bridge.end();
 */
export class DsmlBridge {
  constructor(options = {}) {
    this.model = options.model;
    this.pending = '';
    this.text = '';
    this.inBlock = false;
    this.block = null;
    this.blockBuf = '';
    this.emitted = 0;
    this.textFrames = 0;
    this.finishSent = false;
    this.doneSeen = false;
    this.finished = false;
  }

  stats() {
    return { toolCalls: this.emitted, textFrames: this.textFrames };
  }

  contentFrame(text) {
    if (text === '') return '';
    this.textFrames += 1;
    return 'data: ' + JSON.stringify(chunkBase(this.model, {
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    })) + '\n\n';
  }

  toolFrame(calls) {
    if (calls.length === 0) return '';
    this.emitted += calls.length;
    return 'data: ' + JSON.stringify(chunkBase(this.model, {
      choices: [{
        index: 0,
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: makeId(),
            type: 'function',
            function: { name: call.name, arguments: call.arguments }
          }))
        },
        finish_reason: null
      }]
    })) + '\n\n';
  }

  finishFrame(base, reason) {
    this.finishSent = true;
    const frame = base !== null && typeof base === 'object' ? base : {};
    return 'data: ' + JSON.stringify({
      ...frame,
      id: typeof frame.id === 'string' ? frame.id : 'chatcmpl-wbdsml',
      object: 'chat.completion.chunk',
      created: typeof frame.created === 'number' ? frame.created : Math.floor(Date.now() / 1000),
      ...(this.model === undefined ? {} : { model: this.model }),
      choices: [{ index: 0, delta: {}, finish_reason: reason }]
    }) + '\n\n';
  }

  /** Drain whatever text we can safely convert right now. */
  consumeText() {
    let out = '';
    for (;;) {
      if (!this.inBlock) {
        const open = matchOpen(this.text);
        if (open === null) {
          const hold = holdBack(this.text);
          const flush = this.text.slice(0, this.text.length - hold);
          if (flush !== '') out += this.contentFrame(flush);
          this.text = this.text.slice(this.text.length - hold);
          return out;
        }
        if (open.at > 0) out += this.contentFrame(this.text.slice(0, open.at));
        this.text = this.text.slice(open.at + open.len);
        this.inBlock = true;
        this.block = open.block;
        this.blockBuf = '';
        continue;
      }
      // Search the ACCUMULATED block text: a close tag split across chunks
      // must still be seen once its tail arrives.
      const combined = this.blockBuf + this.text;
      const close = matchClose(combined, this.block);
      if (close === null) {
        const hold = holdClose(this.text, this.block.close);
        const take = this.text.slice(0, this.text.length - hold);
        this.blockBuf += take;
        this.text = this.text.slice(this.text.length - hold);
        if (this.blockBuf.length > MAX_HOLD) {
          // Safety valve: a runaway "block" is really prose - show it.
          out += this.contentFrame(this.blockBuf);
          this.inBlock = false;
          this.block = null;
          this.blockBuf = '';
          this.text = '';
        }
        return out;
      }
      const inner = combined.slice(0, close.at);
      this.text = combined.slice(close.at + close.len);
      const block = this.block;
      this.inBlock = false;
      this.block = null;
      this.blockBuf = '';
      const calls = parseBlock(block, inner);
      if (calls.length === 0) out += this.contentFrame(inner);
      else out += this.toolFrame(calls);
    }
  }

  push(chunk) {
    if (this.finished) return '';
    this.pending += chunk;
    let out = '';
    for (;;) {
      const at = this.pending.indexOf('\n\n');
      if (at === -1) break;
      const frame = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 2);
      out += this.frame(frame);
    }
    return out;
  }

  frame(frame) {
    const line = frame.trim();
    if (!line.startsWith('data:')) return frame + '\n\n';
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') {
      let done = this.flushText();
      if (payload === '') return done + frame + '\n\n';
      this.doneSeen = true;
      if (this.emitted > 0 && !this.finishSent) done += this.finishFrame(null, 'tool_calls');
      return done + 'data: [DONE]\n\n';
    }
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return frame + '\n\n'; }
    const choices = parsed !== null && typeof parsed === 'object' ? parsed['choices'] : undefined;
    const choice = Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
    const delta = choice !== undefined && typeof choice === 'object' ? choice['delta'] : undefined;
    const content = delta !== undefined && delta !== null ? delta['content'] : undefined;
    const finish = choice !== undefined && typeof choice === 'object' ? choice['finish_reason'] : undefined;

    let out = '';
    let handled = false;
    if (typeof content === 'string' && content !== '') {
      handled = true;
      this.text += content;
      out += this.consumeText();
    }
    // The gateway stamps `finish_reason: ""` on EVERY frame, so only a
    // non-empty reason ends the turn. Getting this wrong re-emitted the text
    // once (rewritten frame + the original passed through) - the doubled
    // transcripts this bridge was written to prevent.
    const finishText = typeof finish === 'string' ? finish.trim() : '';
    const finished = finish !== undefined && finish !== null && finishText !== '';
    if (!finished) return handled ? out : out + frame + '\n\n';

    out += this.flushText();
    // A frame we already rewrote must never be forwarded as well.
    if (handled || this.emitted > 0) {
      return out + this.finishFrame(parsed, this.emitted > 0 ? 'tool_calls' : finishText);
    }
    return out + frame + '\n\n';
  }

  /** Emit anything still buffered as text (best-effort parse if mid-block). */
  flushText() {
    let out = '';
    if (this.inBlock) {
      const block = this.block;
      const inner = this.blockBuf + this.text;
      this.inBlock = false;
      this.block = null;
      this.blockBuf = '';
      this.text = '';
      const calls = block === null ? [] : parseBlock(block, inner);
      if (calls.length > 0) return out + this.toolFrame(calls);
      out += this.contentFrame(inner);
      return out;
    }
    if (this.text !== '') {
      out += this.contentFrame(this.text);
      this.text = '';
    }
    return out;
  }

  end() {
    if (this.finished) return '';
    let out = '';
    if (this.pending !== '') {
      const rest = this.pending;
      this.pending = '';
      out += this.frame(rest);
    }
    out += this.flushText();
    if (this.emitted > 0 && !this.finishSent) out += this.finishFrame(null, 'tool_calls');
    this.finished = true;
    return out;
  }
}

export default DsmlBridge;
