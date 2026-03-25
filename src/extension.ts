import * as vscode from 'vscode';
import { exec } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClaudeUsageData {
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

interface WeeklyUsageData {
  weekly?: {
    used_percentage?: number;
    resets_at?: number;
    used?: number;
    limit?: number;
  };
}

interface ContextData {
  context_window?: number;
}

interface ProviderSegment {
  label: string;
  text: string;
  maxPct: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const OUTPUT_CHANNEL_NAME = 'AI Usage';
let outputChannel: vscode.OutputChannel;

function log(msg: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Run a shell command with a 5-second timeout and return parsed JSON.
 * Returns null on failure.
 */
function runCommand<T>(cmd: string): Promise<T | null> {
  return new Promise((resolve) => {
    // 5-second timeout per the spec; keeps the UI responsive even if a command hangs
    const child = exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        log(`Command failed: ${cmd}\n  ${err.message}`);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (parseErr) {
        log(`JSON parse error for command: ${cmd}\n  ${(parseErr as Error).message}`);
        resolve(null);
      }
    });
    // Ensure the process is killed if it times out
    child.on('error', (err) => {
      log(`Process error for command: ${cmd}\n  ${err.message}`);
      resolve(null);
    });
  });
}

/** Render a progress bar of given width using █ (filled) and ░ (empty). */
function renderBar(pct: number, width = 8): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/** Format seconds-until-reset for 5H window as HhMm. */
function formatReset5H(resetAtUnix: number): string {
  const secs = Math.max(0, resetAtUnix - Math.floor(Date.now() / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

/** Format seconds-until-reset for weekly window as DdHh. */
function formatResetWeekly(resetAtUnix: number): string {
  const secs = Math.max(0, resetAtUnix - Math.floor(Date.now() / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d${h}h`;
}

/** Format a context window size, e.g. 200000 → "200k". */
function formatContext(ctx: number | undefined): string {
  if (ctx === undefined || ctx === null) {
    return 'n/a';
  }
  if (ctx >= 1000) {
    return `${Math.round(ctx / 1000)}k`;
  }
  return String(ctx);
}

// ─── Provider fetch functions ─────────────────────────────────────────────────

async function fetchClaudeSegment(cfg: vscode.WorkspaceConfiguration): Promise<ProviderSegment> {
  const usageCmd: string = cfg.get('claudeUsage.command', 'claude-code --status --json');
  const ctxCmd: string = cfg.get('claudeUsage.contextCommand', 'claude-code --context --json');

  const [usageData, ctxData] = await Promise.all([
    runCommand<ClaudeUsageData>(usageCmd),
    runCommand<ContextData>(ctxCmd),
  ]);

  const ctxStr = formatContext(ctxData?.context_window);

  if (!usageData?.rate_limits) {
    return { label: 'Claude', text: `Claude: n/a | Ctx ${ctxStr}`, maxPct: 0 };
  }

  const fh = usageData.rate_limits.five_hour;
  const sd = usageData.rate_limits.seven_day;

  const fhPct = fh?.used_percentage ?? 0;
  const sdPct = sd?.used_percentage ?? 0;

  const fhBar = renderBar(fhPct);
  const sdBar = renderBar(sdPct);

  const fhReset = fh?.resets_at ? ` ${formatReset5H(fh.resets_at)}` : '';
  const sdReset = sd?.resets_at ? ` ${formatResetWeekly(sd.resets_at)}` : '';

  const text =
    `Claude 5H ${fhBar} ${Math.round(fhPct)}%${fhReset}` +
    ` | 7D ${sdBar} ${Math.round(sdPct)}%${sdReset}` +
    ` | Ctx ${ctxStr}`;

  return { label: 'Claude', text, maxPct: Math.max(fhPct, sdPct) };
}

async function fetchWeeklySegment(
  label: string,
  usageCmd: string,
  ctxCmd: string
): Promise<ProviderSegment> {
  const [usageData, ctxData] = await Promise.all([
    runCommand<WeeklyUsageData>(usageCmd),
    runCommand<ContextData>(ctxCmd),
  ]);

  const ctxStr = formatContext(ctxData?.context_window);

  const weekly = usageData?.weekly;
  if (!weekly) {
    return { label, text: `${label}: n/a | Ctx ${ctxStr}`, maxPct: 0 };
  }

  // Derive percentage from used/limit if used_percentage is absent
  let pct: number;
  if (weekly.used_percentage !== undefined) {
    pct = weekly.used_percentage;
  } else if (weekly.used !== undefined && weekly.limit !== undefined && weekly.limit !== 0) {
    pct = (weekly.used / weekly.limit) * 100;
  } else {
    return { label, text: `${label}: n/a | Ctx ${ctxStr}`, maxPct: 0 };
  }

  const bar = renderBar(pct);
  const reset = weekly.resets_at ? ` ${formatResetWeekly(weekly.resets_at)}` : '';
  const text = `${label} wk ${bar} ${Math.round(pct)}%${reset} | Ctx ${ctxStr}`;

  return { label, text, maxPct: pct };
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(sync~spin) AI Usage…';
  statusBar.tooltip = 'AI Usage Bar – loading…';
  statusBar.command = 'aiUsage.refresh';
  statusBar.show();
  context.subscriptions.push(statusBar);

  let polling = false;

  async function refresh(): Promise<void> {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const cfg = vscode.workspace.getConfiguration();

      const [claude, openai, copilot] = await Promise.all([
        fetchClaudeSegment(cfg),
        fetchWeeklySegment(
          'OpenAI',
          cfg.get('openaiUsage.command', 'openai-usage --json'),
          cfg.get('openaiUsage.contextCommand', 'openai-model --info --json')
        ),
        fetchWeeklySegment(
          'Copilot',
          cfg.get('copilotUsage.command', 'copilot-usage --json'),
          cfg.get('copilotUsage.contextCommand', 'copilot-model --info --json')
        ),
      ]);

      const allPcts = [claude.maxPct, openai.maxPct, copilot.maxPct];
      const maxPct = Math.max(...allPcts);

      if (maxPct >= 90) {
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (maxPct >= 80) {
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        statusBar.backgroundColor = undefined;
      }
      statusBar.color = undefined;

      // Short text for the status bar; full detail goes in the tooltip
      const shortParts: string[] = [];
      if (claude.maxPct > 0 || claude.text.indexOf('n/a') === -1) {
        shortParts.push(`Claude ${Math.round(claude.maxPct)}%`);
      } else {
        shortParts.push('Claude n/a');
      }
      if (openai.maxPct > 0 || openai.text.indexOf('n/a') === -1) {
        shortParts.push(`OpenAI ${Math.round(openai.maxPct)}%`);
      } else {
        shortParts.push('OpenAI n/a');
      }
      if (copilot.maxPct > 0 || copilot.text.indexOf('n/a') === -1) {
        shortParts.push(`Copilot ${Math.round(copilot.maxPct)}%`);
      } else {
        shortParts.push('Copilot n/a');
      }
      statusBar.text = `$(pulse) ${shortParts.join(' | ')}`;

      // Rich markdown tooltip with full details
      const tip = new vscode.MarkdownString('', true);
      tip.isTrusted = true;
      tip.appendMarkdown(`**AI Usage Bar** &mdash; _${new Date().toLocaleTimeString()}_\n\n`);
      tip.appendMarkdown(`---\n\n`);
      tip.appendMarkdown(`**Claude:** ${claude.text}\n\n`);
      tip.appendMarkdown(`**OpenAI:** ${openai.text}\n\n`);
      tip.appendMarkdown(`**Copilot:** ${copilot.text}\n\n`);
      tip.appendMarkdown(`---\n\n_Click to refresh_`);
      statusBar.tooltip = tip;
    } catch (err) {
      log(`Unexpected error during refresh: ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  }

  // Register the manual refresh command
  const refreshCmd = vscode.commands.registerCommand('aiUsage.refresh', () => {
    void refresh();
  });
  context.subscriptions.push(refreshCmd);

  // Initial fetch
  void refresh();

  // Polling interval – reads refreshSeconds at start/restart time; config changes restart the timer
  function startInterval(): NodeJS.Timeout {
    const raw: number = vscode.workspace.getConfiguration().get('aiUsage.refreshSeconds', 60);
    const secs = Math.max(5, raw);
    return setInterval(() => void refresh(), secs * 1000);
  }

  let timer = startInterval();

  // Restart interval if the refresh setting changes
  const cfgChange = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('aiUsage.refreshSeconds')) {
      clearInterval(timer);
      timer = startInterval();
    }
  });
  context.subscriptions.push(cfgChange);

  // Ensure timer is cleared on deactivate
  context.subscriptions.push({
    dispose: () => clearInterval(timer),
  });
}

export function deactivate(): void {
  // Subscriptions from the context are disposed automatically; nothing extra needed.
}
