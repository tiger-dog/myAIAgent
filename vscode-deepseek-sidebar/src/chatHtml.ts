import * as vscode from "vscode";

/** CSP meta 的 content 属性转义（含 webview.cspSource 时仍需安全嵌入） */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function getChatPanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  threadId: string,
  cspNonce: string
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "chatPanel.js"));
  const cspDirectives = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} https: data:`,
    /* VS Code 要求 script-src 含 webview.cspSource，否则内联脚本可能整段被拦 */
    `script-src 'nonce-${cspNonce}' ${webview.cspSource}`,
  ].join("; ");
  const cspMetaContent = escapeHtmlAttr(cspDirectives);

  return `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${cspMetaContent}" />
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
    details.meta-card--unknown { border-style: dotted; opacity: 0.95; }
    details.sandbox-card { border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
    details.sandbox-card > summary { color: var(--vscode-errorForeground); font-weight: 600; }
    details.sandbox-card .meta-body pre { color: var(--vscode-errorForeground); }
    .meta-body { padding: 6px 10px 10px; }
    .meta-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; }
    .turn-sep { display: flex; align-items: center; gap: 8px; margin: 14px 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .turn-sep::before, .turn-sep::after { content: ''; flex: 1; height: 1px; background: var(--vscode-widget-border); }
    .status-chip { margin: 4px 0; padding: 4px 8px; border-radius: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); }
    .error-bubble { margin: 8px 0; padding: 8px; border-radius: 6px; border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .approval-banner { margin: 10px 0; padding: 12px; border: 2px solid var(--vscode-inputValidation-warningBorder); border-radius: 6px; background: var(--vscode-inputValidation-warningBackground); }
    .approval-banner.approval-pending { opacity: 0.75; }
    .approval-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
    .approval-actions button { padding: 6px 14px; cursor: pointer; border-radius: 3px; border: 1px solid var(--vscode-widget-border); }
    .approval-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    #composer { display: flex; gap: 6px; margin-top: 8px; }
    #input { flex: 1; min-height: 64px; resize: vertical; font-family: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; }
    #send { align-self: flex-end; padding: 8px 16px; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="modeLabel">模式: <strong id="mode">…</strong></span>
    <button type="button" class="mode" data-mode="plan">Plan</button>
    <button type="button" class="mode" data-mode="agent">Agent</button>
    <button type="button" class="mode" data-mode="yolo">YOLO</button>
  </div>
  <div id="log"></div>
  <div id="composer">
    <textarea id="input" placeholder="输入消息… Enter 发送，Shift+Enter 换行"></textarea>
    <button type="button" id="send">发送</button>
  </div>
  <script nonce="${cspNonce}" src="${escapeHtmlAttr(String(scriptUri))}"></script>
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
