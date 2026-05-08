import * as vscode from "vscode";

export function getChatPanelHtml(
  _webview: vscode.Webview,
  threadId: string,
  cspNonce: string
): string {
  return `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${cspNonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeepSeek ${escapeHtml(threadId.slice(0, 8))}…</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; padding: 8px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
    #toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    #modeLabel { opacity: 0.85; margin-right: 8px; }
    button.mode { padding: 4px 10px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-widget-border); border-radius: 3px; }
    button.mode.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    #log { flex: 1; overflow: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; border-radius: 4px; background: var(--vscode-editor-background); }
    .bubble { margin: 8px 0; padding: 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
    .user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-textLink-foreground); }
    .agent { background: var(--vscode-editor-inactiveSelectionBackground); border-left: 3px solid var(--vscode-charts-green); }
    .sys { opacity: 0.85; font-size: 12px; font-family: var(--vscode-editor-font-family); border-left: 3px solid var(--vscode-charts-yellow); background: var(--vscode-editor-inactiveSelectionBackground); }
    .sys .kind-tag { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    details.reasoning-block { margin: 8px 0; padding: 0; border-radius: 6px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-textBlockQuote-background); }
    details.reasoning-block > summary { cursor: pointer; padding: 6px 10px; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); list-style: none; user-select: none; }
    details.reasoning-block > summary::-webkit-details-marker { display: none; }
    details.reasoning-block[open] > summary { border-bottom: 1px solid var(--vscode-widget-border); }
    .reasoning-body { padding: 8px 10px; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; color: var(--vscode-editor-foreground); opacity: 0.92; font-family: var(--vscode-editor-font-family); }
    details.tool-card { margin: 8px 0; border-radius: 6px; border: 1px solid var(--vscode-charts-blue); background: var(--vscode-sideBar-background); }
    details.tool-card > summary { cursor: pointer; padding: 6px 10px; font-weight: 600; font-size: 12px; list-style: none; }
    details.tool-card > summary::-webkit-details-marker { display: none; }
    details.tool-card[open] > summary { border-bottom: 1px solid var(--vscode-widget-border); }
    .tool-body { padding: 8px 10px; }
    .tool-section { margin-top: 6px; }
    .tool-section:first-child { margin-top: 0; }
    .tool-section .label { font-size: 11px; color: var(--vscode-descriptionForeground); display: block; margin-bottom: 4px; }
    .tool-section pre { margin: 0; padding: 8px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); font-size: 11px; line-height: 1.35; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
    .tool-foot { margin-top: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .tool-card.is-done { border-color: var(--vscode-charts-green); }
    .tool-card.is-fail { border-color: var(--vscode-errorForeground); }
    details.meta-card { margin: 6px 0; border-radius: 4px; border: 1px dashed var(--vscode-widget-border); font-size: 12px; }
    details.meta-card > summary { cursor: pointer; padding: 4px 8px; color: var(--vscode-descriptionForeground); list-style: none; }
    details.meta-card > summary::-webkit-details-marker { display: none; }
    .meta-body { padding: 6px 10px 10px; }
    .meta-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; }
    .turn-sep { display: flex; align-items: center; gap: 8px; margin: 14px 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .turn-sep::before, .turn-sep::after { content: ''; flex: 1; height: 1px; background: var(--vscode-widget-border); }
    .status-chip { margin: 4px 0; padding: 4px 8px; border-radius: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); }
    .error-bubble { margin: 8px 0; padding: 8px; border-radius: 6px; border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); white-space: pre-wrap; }
    #composer { display: flex; gap: 6px; margin-top: 8px; }
    #input { flex: 1; min-height: 64px; resize: vertical; font-family: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; }
    #send { align-self: flex-end; padding: 8px 16px; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="modeLabel">模式: <strong id="mode">…</strong></span>
    <button class="mode" data-mode="plan">Plan</button>
    <button class="mode" data-mode="agent">Agent</button>
    <button class="mode" data-mode="yolo">YOLO</button>
  </div>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" placeholder="输入消息… Enter 发送，Shift+Enter 换行"></textarea>
    <button id="send">发送</button>
  </div>
  <script nonce="${cspNonce}">
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

    function formatMaybeJson(s) {
      if (!s || typeof s !== 'string') return String(s || '');
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch {
        return s;
      }
    }

    function setModeButtons(mode) {
      currentMode = mode;
      modeEl.textContent = mode;
      document.querySelectorAll('button.mode').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
    }

    function isReasoningKind(kind) {
      return kind === 'agent_reasoning' || kind === 'reasoning' || (typeof kind === 'string' && kind.indexOf('reasoning') !== -1);
    }

    function isToolStreamKind(kind) {
      return kind === 'tool_call' || kind === 'file_change' || kind === 'command_execution';
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
      const streamKey = (itemId ? itemId + ':' : '') + kind;
      appendGenericStream(streamKey, delta, kindLabel(kind));
    }

    function handleItemStarted(env) {
      const payload = env.payload || {};
      const item = payload.item;
      if (!item) return;
      const kind = item.kind;
      if (kind === 'user_message' || kind === 'agent_message' || kind === 'agent_reasoning') return;
      const itemId = env.item_id || item.id;
      if (isToolStreamKind(kind)) {
        if (logEl.querySelector('.tool-card[data-item-id="' + itemId + '"]')) return;
        const tool = payload.tool || {};
        const name = tool.name || kindLabel(kind);
        const details = document.createElement('details');
        details.className = 'tool-card';
        details.open = true;
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
      const itemId = env.item_id || item.id;
      const text = item.detail || item.summary || '';

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
        if (last && last.dataset.role === 'agent' && (last.textContent || '').length > 0) return;
        if (last && last.dataset.role === 'agent' && !last.textContent && text) {
          last.textContent = text;
          return;
        }
        if (!text) return;
        const div = document.createElement('div');
        div.className = 'bubble agent';
        div.dataset.role = 'agent';
        div.textContent = text;
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
              if (stream && !stream.textContent) stream.textContent = text;
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
        const details = document.createElement('details');
        details.className = 'meta-card';
        details.open = false;
        const sum = document.createElement('summary');
        sum.textContent = '会话状态 · ' + label;
        const mb = document.createElement('div');
        mb.className = 'meta-body';
        const pre = document.createElement('pre');
        pre.textContent = desc || JSON.stringify(p, null, 2);
        mb.appendChild(pre);
        details.appendChild(sum);
        details.appendChild(mb);
        logEl.appendChild(details);
        return;
      }
      if (ev === 'cycle.advanced') {
        const details = document.createElement('details');
        details.className = 'meta-card';
        details.open = false;
        const sum = document.createElement('summary');
        sum.textContent = '周期推进 · ' + (p.to != null ? 'cycle ' + p.to : 'cycle');
        const mb = document.createElement('div');
        mb.className = 'meta-body';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(p, null, 2);
        mb.appendChild(pre);
        details.appendChild(sum);
        details.appendChild(mb);
        logEl.appendChild(details);
      }
    }

    function handleRuntimeEnv(env) {
      const ev = env.event;
      const payload = env.payload || {};
      const itemId = env.item_id || '';

      if (ev === 'item.delta') {
        const kind = payload.kind || 'unknown';
        const delta = payload.delta || '';
        appendDelta(kind, delta, itemId);
        return;
      }
      if (ev === 'item.started') {
        handleItemStarted(env);
        return;
      }
      if (ev === 'item.completed' || ev === 'item.failed') {
        handleItemFinished(env, ev);
        return;
      }
      handleMetaEvent(env);
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'init') {
        setModeButtons(m.mode || 'agent');
        logEl.innerHTML = '';
      }
      if (m.type === 'mode') {
        setModeButtons(m.mode);
      }
      if (m.type === 'runtimeEvent') {
        handleRuntimeEnv(m.env);
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (m.type === 'error') {
        const d = document.createElement('div');
        d.className = 'bubble sys';
        d.textContent = '错误: ' + m.message;
        logEl.appendChild(d);
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
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
