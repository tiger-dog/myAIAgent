const vscode = acquireVsCodeApi();
const logEl = document.getElementById('log');
const modeEl = document.getElementById('mode');
const inputEl = document.getElementById('input');
let currentMode = 'agent';

const KIND_LABEL = {
  user_message: '用户',
  agent_message: '助手',
  agent_reasoning: '思考',
  tool_call: '工具调用',
  file_change: '文件变更',
  command_execution: '终端命令',
  context_compaction: '上下文整理',
  status: '状态',
  error: '错误',
  unknown: '其它'
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind.replace(/_/g, ' ');
}

/** 自 GET /v1/threads/{id} 的 items 注水（避免仅依赖 SSE 回放） */
function applyHistoryItems(items) {
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i] || {};
    const kind = it.kind;
    const text =
      it.detail != null && String(it.detail).length
        ? String(it.detail)
        : it.summary != null && String(it.summary).length
          ? String(it.summary)
          : '';
    if (!text && kind !== 'agent_reasoning') continue;
    if (kind === 'user_message') {
      const div = document.createElement('div');
      div.className = 'bubble user';
      div.dataset.role = 'user';
      div.dataset.fromHistory = '1';
      div.textContent = text;
      logEl.appendChild(div);
      continue;
    }
    if (kind === 'agent_message') {
      const div = document.createElement('div');
      div.className = 'bubble agent';
      div.dataset.role = 'agent';
      div.dataset.fromHistory = '1';
      div.textContent = text;
      logEl.appendChild(div);
      continue;
    }
    if (kind === 'agent_reasoning' && text) {
      const details = document.createElement('details');
      details.className = 'reasoning-block';
      details.open = false;
      details.dataset.fromHistory = '1';
      const sum = document.createElement('summary');
      sum.textContent = '思考过程（历史）';
      const body = document.createElement('div');
      body.className = 'reasoning-body';
      body.textContent = text;
      details.appendChild(sum);
      details.appendChild(body);
      logEl.appendChild(details);
    }
  }
}

function formatMaybeJson(s) {
  if (!s || typeof s !== 'string') return String(s || '');
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function setModeButtons(mode) {
  const m = String(mode || 'agent').toLowerCase();
  currentMode = m;
  modeEl.textContent = m;
  document.querySelectorAll('button.mode').forEach(b => {
    b.classList.toggle('active', (b.dataset.mode || '') === m);
  });
}

function isReasoningKind(kind) {
  return kind === 'agent_reasoning' || kind === 'reasoning' || (typeof kind === 'string' && kind.indexOf('reasoning') !== -1);
}

function isToolStreamKind(kind) {
  return kind === 'tool_call' || kind === 'file_change' || kind === 'command_execution';
}

/** 与上游 SSE 对齐：item_id 可能在信封或 payload；部分版本仅在 payload.item.id */
function resolveItemIdFromEnv(env, payload, itemFromPayload) {
  const p = payload || {};
  const it = itemFromPayload !== undefined ? itemFromPayload : p.item;
  const raw = env.item_id || p.item_id || (it && it.id) || p.id;
  return raw != null && raw !== '' ? String(raw) : '';
}

function stringifyPayloadPart(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** item.delta 的文本可能在 delta / text / chunk / output 等字段 */
function coalesceDelta(payload) {
  const p = payload || {};
  const keys = ['delta', 'text', 'chunk', 'output', 'stdout', 'stderr', 'content'];
  for (let i = 0; i < keys.length; i++) {
    const v = p[keys[i]];
    if (v != null && v !== '') {
      const s = stringifyPayloadPart(v);
      if (s) return s;
    }
  }
  return '';
}

function resolveFinishedText(payload, item) {
  const p = payload || {};
  const it = item || {};
  const direct = it.detail || it.summary || it.output || it.result;
  if (direct != null && String(direct).length) return stringifyPayloadPart(direct);
  const fall = p.output ?? p.result ?? p.text ?? p.delta;
  if (fall != null && String(fall).length) return stringifyPayloadPart(fall);
  const tool = p.tool || {};
  if (tool.output != null) return stringifyPayloadPart(tool.output);
  return '';
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return String(obj);
  }
}

function appendCollapsedCard(summaryText, bodyText, options) {
  options = options || {};
  const extra = options.extraClass || '';
  const details = document.createElement('details');
  details.className = 'meta-card' + (extra ? ' ' + extra : '');
  details.open = options.open === true;
  if (options.dataAttrs) {
    Object.keys(options.dataAttrs).forEach(function (k) {
      var v = options.dataAttrs[k];
      if (v != null) details.setAttribute('data-' + k, String(v));
    });
  }
  const sum = document.createElement('summary');
  sum.textContent = summaryText;
  const mb = document.createElement('div');
  mb.className = 'meta-body';
  const pre = document.createElement('pre');
  pre.textContent = bodyText || '';
  mb.appendChild(pre);
  details.appendChild(sum);
  details.appendChild(mb);
  logEl.appendChild(details);
  return details;
}

function pickAgentId(p) {
  if (!p) return '';
  return String(p.agent_id || p.agentId || p.subagent_id || p.id || '').trim();
}

function summarizeUsageObj(u) {
  if (!u || typeof u !== 'object') return '';
  var it =
    u.input_tokens != null
      ? u.input_tokens
      : u.prompt_tokens != null
        ? u.prompt_tokens
        : u.input != null
          ? u.input
          : null;
  var ot =
    u.output_tokens != null
      ? u.output_tokens
      : u.completion_tokens != null
        ? u.completion_tokens
        : u.output != null
          ? u.output
          : null;
  if (it != null || ot != null) return ' · tokens ' + (it != null ? it : '?') + '/' + (ot != null ? ot : '?');
  return '';
}

function turnCompletedSummary(p) {
  var u = (p && p.usage) || (p && p.turn && p.turn.usage) || null;
  return '回合完成' + summarizeUsageObj(u);
}

function cssEscapeForSelector(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function appendAgentProgressEvent(payload) {
  var p = payload || {};
  var aid = pickAgentId(p);
  var chunk =
    (typeof p.message === 'string' && p.message) ||
    (typeof p.detail === 'string' && p.detail) ||
    coalesceDelta(p) ||
    '';
  var line = chunk || safeStringify(p);
  if (aid) {
    var esc = cssEscapeForSelector(aid);
    var card = logEl.querySelector('details.agent-progress-card[data-agent-id="' + esc + '"]');
    if (!card) {
      card = document.createElement('details');
      card.className = 'meta-card agent-progress-card';
      card.setAttribute('data-agent-id', aid);
      card.open = false;
      var sum = document.createElement('summary');
      sum.textContent = '子代理进度 · ' + aid.slice(0, 14) + (aid.length > 14 ? '…' : '');
      var mb = document.createElement('div');
      mb.className = 'meta-body';
      var pre = document.createElement('pre');
      pre.textContent = line;
      mb.appendChild(pre);
      card.appendChild(sum);
      card.appendChild(mb);
      logEl.appendChild(card);
    } else {
      var pre2 = card.querySelector('.meta-body pre');
      if (pre2) pre2.textContent += (pre2.textContent ? '\n' : '') + line;
      var sum2 = card.querySelector('summary');
      var short = line.replace(/\s+/g, ' ').slice(0, 72);
      if (sum2)
        sum2.textContent =
          '子代理进度 · ' + aid.slice(0, 10) + (aid.length > 10 ? '…' : '') + ' · ' + short + (line.length > 72 ? '…' : '');
    }
    return;
  }
  appendCollapsedCard('子代理进度', line, { open: false });
}

function appendReasoningDelta(delta, itemId) {
  const id = itemId || '';
  const last = logEl.lastElementChild;
  if (last && last.classList.contains('reasoning-block') && (last.dataset.itemId || '') === id) {
    const body = last.querySelector('.reasoning-body');
    if (body) body.textContent += delta;
    return;
  }
  const details = document.createElement('details');
  details.className = 'reasoning-block';
  details.open = false;
  details.dataset.itemId = id;
  const sum = document.createElement('summary');
  sum.textContent = '思考过程（默认折叠，点击展开）';
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  body.textContent = delta;
  details.appendChild(sum);
  details.appendChild(body);
  logEl.appendChild(details);
}

function appendToolDelta(itemId, delta) {
  if (!itemId) {
    appendGenericStream('tool_orphan', delta, '工具输出');
    return;
  }
  const pre = logEl.querySelector('pre.tool-stream[data-owner="' + itemId + '"]');
  if (pre) {
    pre.textContent += delta;
    return;
  }
  appendGenericStream('tool_' + itemId, delta, '工具输出');
}

function appendGenericStream(streamKey, delta, title) {
  const last = logEl.lastElementChild;
  if (last && last.dataset.streamKey === streamKey) {
    const inner = last.querySelector('.stream-body');
    if (inner) inner.textContent += delta;
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'bubble sys';
  wrap.dataset.streamKey = streamKey;
  const tag = document.createElement('span');
  tag.className = 'kind-tag';
  tag.textContent = title;
  const inner = document.createElement('div');
  inner.className = 'stream-body';
  inner.style.whiteSpace = 'pre-wrap';
  inner.textContent = delta;
  wrap.appendChild(tag);
  wrap.appendChild(inner);
  logEl.appendChild(wrap);
}

function appendDelta(kind, delta, itemId) {
  if (kind === 'user_message' || kind === 'agent_message') {
    if (delta === undefined || delta === null) return;
    const role = kind === 'user_message' ? 'user' : 'agent';
    const last = logEl.lastElementChild;
    const sid = itemId || '';
    if (last && last.dataset.role === role) {
      const lastSid = last.dataset.streamItem || '';
      const sameStream = !sid || !lastSid || lastSid === sid;
      if (sameStream) {
        if (sid && !lastSid) last.dataset.streamItem = sid;
        last.textContent += delta;
        return;
      }
    }
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    div.dataset.role = role;
    if (sid) div.dataset.streamItem = sid;
    div.textContent = delta;
    logEl.appendChild(div);
    return;
  }
  if (isReasoningKind(kind)) {
    appendReasoningDelta(delta, itemId);
    return;
  }
  if (isToolStreamKind(kind)) {
    appendToolDelta(itemId, delta);
    return;
  }
  /* 上游若使用未文档化的 kind，仍可将增量写入已存在的工具卡片 */
  if (itemId && delta && logEl.querySelector('.tool-card[data-item-id="' + itemId + '"]')) {
    appendToolDelta(itemId, delta);
    return;
  }
  const streamKey = (itemId ? itemId + ':' : '') + kind;
  appendGenericStream(streamKey, delta, kindLabel(kind));
}

function handleItemStarted(env) {
  const payload = env.payload || {};
  const item = payload.item;
  if (!item) return;
  const kind = item.kind;
  if (kind === 'user_message' || kind === 'agent_message' || kind === 'agent_reasoning') return;
  const itemId = resolveItemIdFromEnv(env, payload, item);
  if (isToolStreamKind(kind)) {
    if (logEl.querySelector('.tool-card[data-item-id="' + itemId + '"]')) return;
    const tool = payload.tool || {};
    const name = tool.name || kindLabel(kind);
    const details = document.createElement('details');
    details.className = 'tool-card';
    details.open = false;
    details.dataset.itemId = itemId;
    const sum = document.createElement('summary');
    sum.textContent = (kind === 'file_change' ? '📄 ' : kind === 'command_execution' ? '⌨ ' : '🔧 ') + name;
    const body = document.createElement('div');
    body.className = 'tool-body';
    const inSec = document.createElement('div');
    inSec.className = 'tool-section';
    const inLab = document.createElement('span');
    inLab.className = 'label';
    inLab.textContent = '输入 / 参数';
    const inPre = document.createElement('pre');
    inPre.className = 'tool-input';
    let rawIn = '';
    try {
      rawIn = tool.input !== undefined ? JSON.stringify(tool.input, null, 2) : formatMaybeJson(item.detail || '');
    } catch {
      rawIn = String(item.detail || '');
    }
    inPre.textContent = rawIn || '（无）';
    inSec.appendChild(inLab);
    inSec.appendChild(inPre);
    const outSec = document.createElement('div');
    outSec.className = 'tool-section';
    const outLab = document.createElement('span');
    outLab.className = 'label';
    outLab.textContent = '输出（流式）';
    const outPre = document.createElement('pre');
    outPre.className = 'tool-stream';
    outPre.dataset.owner = itemId;
    outSec.appendChild(outLab);
    outSec.appendChild(outPre);
    body.appendChild(inSec);
    body.appendChild(outSec);
    details.appendChild(sum);
    details.appendChild(body);
    logEl.appendChild(details);
    return;
  }
  if (kind === 'context_compaction') {
    if (logEl.querySelector('.meta-card[data-item-id="' + itemId + '"]')) return;
    const details = document.createElement('details');
    details.className = 'meta-card';
    details.open = false;
    details.dataset.itemId = itemId;
    const sum = document.createElement('summary');
    sum.textContent = '上下文整理（已开始）';
    const mb = document.createElement('div');
    mb.className = 'meta-body';
    const pre = document.createElement('pre');
    pre.textContent = item.summary || item.detail || '';
    mb.appendChild(pre);
    details.appendChild(sum);
    details.appendChild(mb);
    logEl.appendChild(details);
  }
}

function handleItemFinished(env, ev) {
  const payload = env.payload || {};
  const item = payload.item;
  if (!item) return;
  const kind = item.kind;
  const itemId = resolveItemIdFromEnv(env, payload, item);
  const text = resolveFinishedText(payload, item);

  if (kind === 'user_message') {
    const last = logEl.lastElementChild;
    if (last && last.dataset.role === 'user' && last.dataset.fromCompleted === itemId) return;
    const div = document.createElement('div');
    div.className = 'bubble user';
    div.dataset.role = 'user';
    div.dataset.fromCompleted = itemId;
    div.textContent = text;
    logEl.appendChild(div);
    return;
  }

  if (kind === 'agent_message') {
    const last = logEl.lastElementChild;
    const lastIsAgent = last && last.dataset.role === 'agent';
    const cur = lastIsAgent ? last.textContent || '' : '';
    const lastLen = cur.length;
    const t = text != null ? String(text) : '';
    const finLen = t.length;
    /** 完成事件若携带比流式更长的正文，必须用其覆盖（原逻辑在此直接 return 会导致截断） */
    let appliedLongerMerge = false;
    if (lastIsAgent && finLen > lastLen) {
      last.textContent = t;
      appliedLongerMerge = true;
    }
    const wouldSkipMergeOldBug = !!(lastIsAgent && lastLen > 0 && !appliedLongerMerge);
    // #region agent log
    vscode.postMessage({
      type: '_debugLog',
      payload: {
        runId: 'post-fix',
        hypothesisId: 'H1',
        location: 'chatPanel.js:handleItemFinished',
        message: 'agent_message completed (UI branch)',
        data: { lastLen, finLen, wouldSkipMergeOldBug, appliedLongerMerge, itemId: itemId || null }
      }
    });
    // #endregion
    if (appliedLongerMerge) return;
    if (lastIsAgent && lastLen > 0) return;
    if (lastIsAgent && !lastLen && t) {
      last.textContent = t;
      return;
    }
    if (!t) return;
    const div = document.createElement('div');
    div.className = 'bubble agent';
    div.dataset.role = 'agent';
    div.textContent = t;
    logEl.appendChild(div);
    return;
  }

  if (kind === 'agent_reasoning') {
    const card = logEl.querySelector('.reasoning-block[data-item-id="' + itemId + '"]');
    if (card) {
      const sum = card.querySelector('summary');
      if (sum) sum.textContent = '思考过程（已完成，点击展开查看）';
    }
    return;
  }

  if (isToolStreamKind(kind)) {
    const card = logEl.querySelector('.tool-card[data-item-id="' + itemId + '"]');
    if (card) {
      card.classList.add(ev === 'item.failed' ? 'is-fail' : 'is-done');
      const body = card.querySelector('.tool-body');
      if (body) {
        if (!body.querySelector('.tool-foot')) {
          const foot = document.createElement('div');
          foot.className = 'tool-foot';
          foot.textContent = ev === 'item.failed' ? '✗ 工具执行失败' : '✓ 工具执行完成';
          body.appendChild(foot);
        }
        if (text) {
          const stream = body.querySelector('pre.tool-stream');
          if (stream) {
            const cur = stream.textContent || '';
            if (!cur) stream.textContent = text;
            else if (text.length > cur.length) stream.textContent = text;
          }
        }
      }
    }
    return;
  }

  if (kind === 'context_compaction') {
    let card = logEl.querySelector('.meta-card[data-item-id="' + itemId + '"]');
    if (!card) {
      card = document.createElement('details');
      card.className = 'meta-card';
      card.open = false;
      card.dataset.itemId = itemId;
      const s0 = document.createElement('summary');
      s0.textContent = '上下文整理';
      const mb0 = document.createElement('div');
      mb0.className = 'meta-body';
      card.appendChild(s0);
      card.appendChild(mb0);
      logEl.appendChild(card);
    }
    const sum = card.querySelector('summary');
    if (sum) sum.textContent = '上下文整理（' + (ev === 'item.failed' ? '失败' : '完成') + '）';
    const mb = card.querySelector('.meta-body');
    if (mb) {
      mb.innerHTML = '';
      const pre = document.createElement('pre');
      pre.textContent = text;
      if (payload.messages_before != null) {
        pre.textContent += '\\n\\n消息数: ' + payload.messages_before + ' → ' + (payload.messages_after != null ? payload.messages_after : '?');
      }
      mb.appendChild(pre);
    }
    return;
  }

  if (kind === 'status') {
    if (ev === 'item.failed') {
      const div = document.createElement('div');
      div.className = 'error-bubble';
      div.textContent = '状态异常：' + (text || '未知');
      logEl.appendChild(div);
      return;
    }
    const div = document.createElement('div');
    div.className = 'status-chip';
    div.textContent = 'ⓘ ' + (text || kindLabel(kind));
    logEl.appendChild(div);
    return;
  }

  if (kind === 'error') {
    const div = document.createElement('div');
    div.className = 'error-bubble';
    div.textContent = text || '未知错误';
    logEl.appendChild(div);
  }
}

function stringifyApprovalDesc(d) {
  if (d == null || d === '') return '';
  if (typeof d === 'string') return d;
  try {
    return JSON.stringify(d, null, 2);
  } catch {
    return String(d);
  }
}

function removeApprovalBanner(approvalId) {
  if (!approvalId) return;
  const el = logEl.querySelector('.approval-banner[data-approval-id="' + approvalId + '"]');
  if (el) el.remove();
}

function showApprovalBanner(payload) {
  const p = payload || {};
  const aid = p.approval_id || p.id;
  if (!aid) return;
  if (logEl.querySelector('.approval-banner[data-approval-id="' + aid + '"]')) return;
  const wrap = document.createElement('div');
  wrap.className = 'approval-banner';
  wrap.dataset.approvalId = String(aid);
  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.style.marginBottom = '6px';
  title.textContent = '需要审批：即将执行工具';
  const tool = document.createElement('div');
  tool.style.fontSize = '12px';
  tool.style.opacity = '0.9';
  tool.textContent = '工具: ' + (p.tool_name || '（未知）');
  const desc = document.createElement('div');
  desc.style.marginTop = '8px';
  desc.style.whiteSpace = 'pre-wrap';
  desc.style.wordBreak = 'break-word';
  desc.style.fontSize = '12px';
  desc.textContent = stringifyApprovalDesc(p.description) || '（无说明）';
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const hint = document.createElement('div');
  hint.style.flexBasis = '100%';
  hint.style.fontSize = '11px';
  hint.style.color = 'var(--vscode-descriptionForeground)';
  hint.style.marginTop = '2px';
  hint.textContent =
    '说明：HTTP 运行时与 TUI 相同，底层只有 allow / deny；「自动批准」用 remember 标记（等价于 TUI 里「始终允许」类选项）。';
  const btnOnce = document.createElement('button');
  btnOnce.type = 'button';
  btnOnce.textContent = '允许（仅本次）';
  btnOnce.title = 'decision=allow, remember=false';
  btnOnce.style.background = 'var(--vscode-button-background)';
  btnOnce.style.color = 'var(--vscode-button-foreground)';
  const btnAlways = document.createElement('button');
  btnAlways.type = 'button';
  btnAlways.textContent = '允许并自动批准';
  btnAlways.title = 'decision=allow, remember=true（本会话后续需审批的工具改为自动批准）';
  btnAlways.style.background = 'var(--vscode-button-background)';
  btnAlways.style.color = 'var(--vscode-button-foreground)';
  const btnDeny = document.createElement('button');
  btnDeny.type = 'button';
  btnDeny.textContent = '拒绝';
  btnDeny.title = 'decision=deny';
  btnDeny.style.background = 'var(--vscode-button-secondaryBackground)';
  btnDeny.style.color = 'var(--vscode-button-secondaryForeground)';
  const allBtns = [btnOnce, btnAlways, btnDeny];
  function lockButtons() {
    allBtns.forEach((b) => {
      b.disabled = true;
    });
    wrap.classList.add('approval-pending');
  }
  btnOnce.addEventListener('click', () => {
    vscode.postMessage({
      type: 'approvalDecision',
      approvalId: String(aid),
      decision: 'allow',
      remember: false
    });
    lockButtons();
  });
  btnAlways.addEventListener('click', () => {
    vscode.postMessage({
      type: 'approvalDecision',
      approvalId: String(aid),
      decision: 'allow',
      remember: true
    });
    lockButtons();
  });
  btnDeny.addEventListener('click', () => {
    vscode.postMessage({
      type: 'approvalDecision',
      approvalId: String(aid),
      decision: 'deny',
      remember: false
    });
    lockButtons();
  });
  actions.appendChild(btnOnce);
  actions.appendChild(btnAlways);
  actions.appendChild(btnDeny);
  actions.appendChild(hint);
  wrap.appendChild(title);
  wrap.appendChild(tool);
  wrap.appendChild(desc);
  wrap.appendChild(actions);
  logEl.appendChild(wrap);
}

function handleMetaEvent(env) {
  const ev = env.event;
  const p = env.payload || {};
  if (ev === 'turn.started') {
    const div = document.createElement('div');
    div.className = 'turn-sep';
    const span = document.createElement('span');
    span.textContent = '新回合';
    div.appendChild(span);
    logEl.appendChild(div);
    return;
  }
  if (ev === 'coherence.state') {
    const label = p.label || p.state || '状态更新';
    const desc = p.description || p.reason || '';
    appendCollapsedCard('会话状态 · ' + label, desc || safeStringify(p), { open: false });
    return;
  }
  if (ev === 'cycle.advanced') {
    appendCollapsedCard(
      '周期推进 · ' + (p.to != null ? 'cycle ' + p.to : 'cycle'),
      safeStringify(p),
      { open: false }
    );
    return;
  }
  const seqPart = env.seq != null ? ' (#' + env.seq + ')' : '';
  appendCollapsedCard('事件 · ' + ev + seqPart, safeStringify(env), {
    open: false,
    extraClass: 'meta-card--unknown',
  });
}

function handleRuntimeEnv(env) {
  const ev = env.event;
  const payload = env.payload || {};

  if (ev === 'item.delta') {
    const kind = payload.kind || 'unknown';
    const itemId = resolveItemIdFromEnv(env, payload, payload.item);
    const delta = coalesceDelta(payload);
    appendDelta(kind, delta, itemId);
    return;
  }
  if (ev === 'item.started') {
    handleItemStarted(env);
    return;
  }
  if (ev === 'item.completed' || ev === 'item.failed' || ev === 'item.interrupted') {
    handleItemFinished(env, ev === 'item.failed' || ev === 'item.interrupted' ? 'item.failed' : 'item.completed');
    return;
  }
  if (ev === 'approval.required') {
    showApprovalBanner(payload);
    return;
  }
  if (ev === 'approval.decided') {
    const aid = payload.approval_id || payload.id;
    removeApprovalBanner(aid);
    const div = document.createElement('div');
    div.className = 'status-chip';
    const dec = payload.decision || '';
    const label = dec === 'allow' ? '已允许' : dec === 'deny' ? '已拒绝' : dec;
    div.textContent = '审批结果: ' + label + (aid ? ' · ' + String(aid).slice(0, 10) + '…' : '');
    logEl.appendChild(div);
    return;
  }
  if (ev === 'approval.timeout') {
    const aid = payload.approval_id || payload.id;
    removeApprovalBanner(aid);
    const div = document.createElement('div');
    div.className = 'error-bubble';
    div.textContent =
      '审批超时，工具已取消' +
      (payload.timeout_secs != null ? '（' + payload.timeout_secs + 's）' : '');
    logEl.appendChild(div);
    return;
  }
  if (ev === 'sandbox.denied') {
    const tn = payload.tool_name || '';
    const r = payload.reason || '';
    const summary = '沙箱拒绝' + (tn ? ' · ' + tn : '');
    const body = (r ? r + '\n\n' : '') + safeStringify(payload);
    appendCollapsedCard(summary, body, { open: false, extraClass: 'sandbox-card' });
    return;
  }
  if (ev === 'thread.started') {
    appendCollapsedCard('线程已开始', safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'thread.updated') {
    appendCollapsedCard('线程已更新', safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'thread.forked') {
    appendCollapsedCard('线程已分叉', safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'turn.lifecycle') {
    const phase = payload.status || payload.phase || payload.state || '';
    appendCollapsedCard('回合状态' + (phase ? ' · ' + phase : ''), safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'turn.steered') {
    appendCollapsedCard('回合 steer', safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'turn.interrupt_requested') {
    appendCollapsedCard('中断已请求', safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'turn.completed') {
    appendCollapsedCard(turnCompletedSummary(payload), safeStringify(payload), { open: false });
    return;
  }
  if (ev === 'agent.spawned') {
    const sid = pickAgentId(payload) || (payload.name ? String(payload.name) : '');
    appendCollapsedCard(
      '子代理已启动' + (sid ? ' · ' + sid.slice(0, 28) + (sid.length > 28 ? '…' : '') : ''),
      safeStringify(payload),
      { open: false }
    );
    return;
  }
  if (ev === 'agent.progress') {
    appendAgentProgressEvent(payload);
    return;
  }
  if (ev === 'agent.completed') {
    const ac = pickAgentId(payload);
    appendCollapsedCard(
      '子代理已结束' + (ac ? ' · ' + ac.slice(0, 24) + (ac.length > 24 ? '…' : '') : ''),
      safeStringify(payload),
      { open: false }
    );
    return;
  }
  if (ev === 'agent.list') {
    appendCollapsedCard('子代理列表', safeStringify(payload), { open: false });
    return;
  }
  handleMetaEvent(env);
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  try {
  if (m.type === 'init') {
    setModeButtons(m.mode || 'agent');
    logEl.innerHTML = '';
    applyHistoryItems(m.items);
  }
  if (m.type === 'mode') {
    setModeButtons(m.mode);
  }
  if (m.type === 'runtimeEvent' && m.env && typeof m.env === 'object') {
    handleRuntimeEnv(m.env);
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (m.type === 'error') {
    const d = document.createElement('div');
    d.className = 'bubble sys';
    d.textContent = '错误: ' + (m.message != null ? String(m.message) : '');
    logEl.appendChild(d);
  }
  if (m.type === 'approvalResolved') {
    removeApprovalBanner(m.approvalId);
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (m.type === 'approvalError') {
    const wrap = m.approvalId
      ? logEl.querySelector('.approval-banner[data-approval-id="' + m.approvalId + '"]')
      : null;
    if (wrap) {
      wrap.classList.remove('approval-pending');
      wrap.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
    }
    const d = document.createElement('div');
    d.className = 'error-bubble';
    d.textContent = '审批提交失败: ' + (m.message || '');
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }
  } catch (err) {
    console.error('deepseek webview message handler', err);
  }
});

    document.querySelectorAll('button.mode').forEach(b => {
      b.addEventListener('click', () => {
        vscode.postMessage({ type: 'setMode', mode: b.dataset.mode });
      });
    });

    function send() {
      const t = inputEl.value.trim();
      if (!t) return;
      vscode.postMessage({ type: 'sendPrompt', prompt: t });
      inputEl.value = '';
    }
document.getElementById('send').addEventListener('click', send);
inputEl.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing) return;
  // Shift+Enter：换行；Enter / Ctrl+Enter / Cmd+Enter：发送（与常见 IM 一致）
  if (ev.shiftKey) return;
  ev.preventDefault();
  send();
});

    vscode.postMessage({ type: 'ready' });
