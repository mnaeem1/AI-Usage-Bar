import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, execFile } from 'child_process';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CopilotUserInfo {
  copilot_plan?: string;
  quota_snapshots?: {
    premium_interactions?: {
      unlimited: boolean;
      overage_permitted: boolean;
      overage_count: number;
      entitlement: number;
      percent_remaining: number;
    };
  };
  quota_reset_date?: string;
}

interface ClaudeOAuthUsage {
  five_hour?: { utilization: number; resets_at: string } | null;
  seven_day?: { utilization: number; resets_at: string } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string } | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

interface CodexCliUsageJson {
  plan?: string;
  '5h'?: { pct: number; resets_at: string };
  '7d'?: { pct: number; resets_at: string };
}

interface ClaudeContextBridge {
  session_id: string;
  remaining_percentage: number;
  used_pct: number;
  timestamp: number;
}

interface ProviderSegment {
  label: string;
  short: string;
  detail: string;
  maxPct: number;
}

type ProviderKey = 'claude' | 'codex' | 'copilot';

interface ProviderConfig {
  claude: boolean;
  codex: boolean;
  copilot: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const OUTPUT_CHANNEL_NAME = 'AI Usage';
let outputChannel: vscode.OutputChannel;
let debugLogsEnabled = false;

function log(msg: string): void {
  if (!debugLogsEnabled) { return; }
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function logAlways(msg: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function renderBar(pct: number, width = 8): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '\\[' + '█'.repeat(filled) + '░'.repeat(empty) + '\\]';
}

/**
 * Returns an HTML hex color for a usage percentage.
 * Green below 50%, then yellow → darker shades every 10% → red at 100%.
 */
function getUsageColor(pct: number): string {
  if (pct < 50)   { return '#44cc88'; }   // green
  if (pct >= 100) { return '#ff2222'; }   // red
  // Gradient: 50%=light-yellow, 60%=yellow, 70%=amber, 80%=orange, 90%=dark-orange (each 10% darker)
  const step = Math.min(Math.floor((pct - 50) / 10), 4);
  return ['#ffee00', '#ffcc00', '#ffaa00', '#ff8800', '#ff5500'][step];
}

/** Returns an emoji circle conveying urgency for the given percentage. */
function getUsageEmoji(pct: number): string {
  if (pct >= 90) { return '🔴'; }
  if (pct >= 70) { return '🟠'; }
  if (pct >= 50) { return '🟡'; }
  return '🟢';
}

/** Wraps a percentage value in an HTML color span for use in the tooltip. */
function coloredPct(pct: number): string {
  return `<span style="color:${getUsageColor(pct)}">${Math.round(pct)}%</span>`;
}

/** Formats a percentage with an emoji indicator for the compact status bar text. */
function emojiPct(pct: number): string {
  return `${getUsageEmoji(pct)}${Math.round(pct)}%`;
}

function formatCountdown(targetDate: Date): string {
  const secs = Math.max(0, Math.floor((targetDate.getTime() - Date.now()) / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) {
    return `${d}d${h}h`;
  }
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getProviderConfig(): ProviderConfig {
  const cfg = vscode.workspace.getConfiguration();
  return {
    claude: cfg.get<boolean>('aiUsage.providers.claude', true),
    codex: cfg.get<boolean>('aiUsage.providers.codex', true),
    copilot: cfg.get<boolean>('aiUsage.providers.copilot', true),
  };
}

function isProviderEnabled(provider: ProviderKey): boolean {
  return getProviderConfig()[provider];
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readMacKeychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(stdout.trim());
      }
    );
  });
}

// ─── Cross-environment helpers ───────────────────────────────────────────────

function isWsl(): boolean {
  if (process.platform !== 'linux') { return false; }
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch { return false; }
}

/**
 * Find a file relative to the user's home directory, checking both native
 * and (on WSL) Windows home via /mnt/c/Users/...
 */
function findHomeFile(relativePath: string): string | null {
  const home = os.homedir();
  const primary = path.join(home, relativePath);
  if (fs.existsSync(primary)) { return primary; }

  if (isWsl()) {
    try {
      const entries = fs.readdirSync('/mnt/c/Users')
        .filter(u => !['Public', 'Default', 'Default User', 'All Users'].includes(u) && !u.startsWith('.'));
      for (const u of entries) {
        const p = path.join('/mnt/c/Users', u, relativePath);
        if (fs.existsSync(p)) { return p; }
      }
    } catch { /* silent */ }
  }
  return null;
}

/**
 * Run a shell command, using login shell on Linux to pick up user's PATH
 * (handles pyenv, conda, nvm, etc.).
 */
function runCommand(cmd: string, timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.platform === 'linux' ? '/bin/bash' : undefined;
    const wrappedCmd = process.platform === 'linux' ? `bash -lc '${cmd.replace(/'/g, "'\\''")}'` : cmd;

    exec(wrappedCmd, { timeout: timeoutMs, env: process.env, shell }, (err, stdout, stderr) => {
      if (err) {
        log(`cmd failed [${cmd}]: ${err.message.split('\n')[0]}${stderr ? ' | ' + stderr.trim().split('\n')[0] : ''}`);
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Run a Python module trying multiple Python executables.
 * On Linux uses login shell so user-installed packages are found.
 */
function runPythonModule(moduleName: string, args: string): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3'];

  const errors: string[] = [];
  return new Promise((resolve) => {
    let tried = 0;
    function tryNext(): void {
      if (tried >= candidates.length) {
        log(`Python module ${moduleName} failed all candidates:\n  ${errors.join('\n  ')}`);
        resolve(null);
        return;
      }
      const pyCmd = candidates[tried];
      const rawCmd = `${pyCmd} -m ${moduleName} ${args}`;
      // On Linux, wrap in login shell so ~/.local/bin is on PATH
      const cmd = process.platform === 'linux'
        ? `bash -lc '${rawCmd}'`
        : rawCmd;
      tried++;
      exec(cmd, { timeout: 15000, env: process.env }, (err, stdout, stderr) => {
        if (err) {
          errors.push(`${pyCmd}: ${err.message.split('\n')[0]}${stderr ? ' | ' + stderr.trim().split('\n')[0] : ''}`);
          tryNext();
          return;
        }
        resolve(stdout.trim());
      });
    }
    tryNext();
  });
}

/**
 * Decode a JWT payload (base64url) without verification.
 */
function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) { return null; }
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch { return null; }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache: Record<string, { segment: ProviderSegment; at: number }> = {};

function getCached(key: string, maxAgeMs: number): ProviderSegment | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.at < maxAgeMs) {
    return entry.segment;
  }
  return null;
}

function setCache(key: string, segment: ProviderSegment): void {
  cache[key] = { segment, at: Date.now() };
}

function disabledSegment(label: string): ProviderSegment {
  return { label, short: `${label} off`, detail: `${label}: disabled`, maxPct: 0 };
}

// ─── Claude Context (bridge file from statusline) ─────────────────────────────

function getClaudeContext(): { usedPct: number } | null {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('claude-ctx-') && f.endsWith('.json'))
      .map(f => {
        const full = path.join(tmpDir, f);
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) { return null; }
    if (Date.now() - files[0].mtime > 10 * 60 * 1000) { return null; }

    const data = readJsonFile<ClaudeContextBridge>(files[0].path);
    if (data && typeof data.used_pct === 'number') {
      return { usedPct: data.used_pct };
    }
  } catch { /* silent */ }
  return null;
}

// ─── Claude Code ──────────────────────────────────────────────────────────────

async function getClaudeToken(): Promise<string | null> {
  const credPath = findHomeFile(path.join('.claude', '.credentials.json'));
  if (credPath) {
    const creds = readJsonFile<Record<string, { accessToken?: string }>>(credPath);
    if (creds?.claudeAiOauth?.accessToken) {
      log(`Claude: found token at ${credPath}`);
      return creds.claudeAiOauth.accessToken;
    }
  }
  if (process.platform === 'darwin') {
    const keychainRaw = await readMacKeychain('Claude Code-credentials');
    if (keychainRaw) {
      try {
        const parsed = JSON.parse(keychainRaw) as { claudeAiOauth?: { accessToken?: string } };
        return parsed.claudeAiOauth?.accessToken ?? null;
      } catch { /* silent */ }
    }
  }
  return null;
}

function getClaudeApiMinIntervalMs(): number {
  const mins = vscode.workspace.getConfiguration().get<number>('aiUsage.claudeMinApiMinutes', 5);
  return Math.max(1, mins) * 60 * 1000;
}

async function fetchClaudeSegment(): Promise<ProviderSegment> {
  const label = 'Claude';
  try {
    // Reuse recent cache to avoid hammering the rate-limited endpoint
    // (Claude Code's native display shares this same API quota)
    const recent = getCached('claude', getClaudeApiMinIntervalMs());
    if (recent) {
      const segment: ProviderSegment = { ...recent };
      const ctx = getClaudeContext();
      if (ctx) {
      segment.short = segment.short.replace(/ Ctx:\S+/, '') + ` Ctx:${emojiPct(ctx.usedPct)}`;
      segment.detail = segment.detail.replace(/ \| Ctx .*$/, '') + ` | Ctx ${renderBar(ctx.usedPct, 6)} ${coloredPct(ctx.usedPct)}`;
      }
      return segment;
    }

    const token = await getClaudeToken();
    if (!token) {
      return { label, short: 'Claude ⚠', detail: 'Claude: not logged in', maxPct: 0 };
    }

    const response = await fetchWithTimeout('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ai-usage-bar-vscode',
      },
    }, 12000);

    if (response.status === 429) {
      log('Claude: rate limited (429), using cache');
      const cached = getCached('claude', 30 * 60 * 1000);
      if (cached) { return cached; }
      return { label, short: 'Claude ⏳', detail: 'Claude: rate limited (waiting…)', maxPct: 0 };
    }

    if (!response.ok) {
      log(`Claude API ${response.status}`);
      if (response.status === 401) {
        return { label, short: 'Claude ✕', detail: 'Claude: token expired (re-login)', maxPct: 0 };
      }
      return { label, short: 'Claude ✕', detail: `Claude: API error ${response.status}`, maxPct: 0 };
    }

    const data = (await response.json()) as ClaudeOAuthUsage;
    const fhPct = data.five_hour?.utilization ?? 0;
    const sdPct = data.seven_day?.utilization ?? 0;
    const ctx = getClaudeContext();

    const fhReset = data.five_hour?.resets_at ? formatCountdown(new Date(data.five_hour.resets_at)) : '';
    const sdReset = data.seven_day?.resets_at ? formatCountdown(new Date(data.seven_day.resets_at)) : '';

    let short = `Claude ${emojiPct(fhPct)}`;
    if (ctx) { short += ` Ctx:${emojiPct(ctx.usedPct)}`; }

    let detail =
      `Claude 5H ${renderBar(fhPct)} ${coloredPct(fhPct)} ${fhReset}` +
      ` | 7D ${renderBar(sdPct)} ${coloredPct(sdPct)} ${sdReset}`;
    if (ctx) { detail += ` | Ctx ${renderBar(ctx.usedPct, 6)} ${coloredPct(ctx.usedPct)}`; }
    if (data.seven_day_sonnet) {
      detail += ` | Sonnet ${coloredPct(data.seven_day_sonnet.utilization)}`;
    }

    const segment: ProviderSegment = { label, short, detail, maxPct: Math.max(fhPct, sdPct) };
    setCache('claude', segment);
    return segment;
  } catch (err) {
    log(`Claude fetch error: ${(err as Error).message}`);
    return getCached('claude', 30 * 60 * 1000) ??
      { label, short: 'Claude ✕', detail: 'Claude: fetch error', maxPct: 0 };
  }
}

// ─── OpenAI Codex ─────────────────────────────────────────────────────────────

function getCodexAuth(): { token: string; plan: string } | null {
  const authPath = findHomeFile(path.join('.codex', 'auth.json'));
  if (!authPath) {
    log('Codex: no auth.json found');
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auth = readJsonFile<any>(authPath);
  const token = auth?.tokens?.access_token ?? auth?.access_token;
  if (!token) {
    log(`Codex: auth.json at ${authPath} has no access_token`);
    return null;
  }

  log(`Codex: found auth at ${authPath}`);

  const claims = parseJwtPayload(token);
  const plan = (claims?.['https://api.openai.com/auth'] as Record<string, string>)?.chatgpt_plan_type ?? 'unknown';
  return { token, plan };
}

async function fetchCodexSegment(): Promise<ProviderSegment> {
  const label = 'Codex';
  try {
    // Strategy 1: Python module (most reliable when installed)
    const raw = await runPythonModule('codex_cli_usage', 'json');
    if (raw) {
      let data: CodexCliUsageJson;
      try { data = JSON.parse(raw); } catch {
        log(`Codex: bad JSON from codex_cli_usage: ${raw.substring(0, 100)}`);
        return { label, short: 'Codex ✕', detail: 'Codex: bad response from CLI', maxPct: 0 };
      }

      const fhPct = data['5h']?.pct ?? 0;
      const sdPct = data['7d']?.pct ?? 0;
      const fhReset = data['5h']?.resets_at ? formatCountdown(new Date(data['5h'].resets_at)) : '';
      const sdReset = data['7d']?.resets_at ? formatCountdown(new Date(data['7d'].resets_at)) : '';

      const short = `Codex ${emojiPct(fhPct)}`;
      const detail =
        `Codex (${data.plan ?? '?'}) 5H ${renderBar(fhPct)} ${coloredPct(fhPct)} ${fhReset}` +
        ` | 7D ${renderBar(sdPct)} ${coloredPct(sdPct)} ${sdReset}`;

      const segment: ProviderSegment = { label, short, detail, maxPct: Math.max(fhPct, sdPct) };
      setCache('codex', segment);
      return segment;
    }

    // Strategy 2: Read auth.json and show plan info
    const auth = getCodexAuth();
    if (auth) {
      const cached = getCached('codex', 30 * 60 * 1000);
      if (cached) { return cached; }

      return {
        label,
        short: `Codex (${auth.plan}) ✓`,
        detail: `Codex (${auth.plan}): logged in — install codex-cli-usage for usage data`,
        maxPct: 0,
      };
    }

    return { label, short: 'Codex --', detail: 'Codex: not logged in (run `codex` CLI to auth)', maxPct: 0 };
  } catch (err) {
    log(`Codex fetch error: ${(err as Error).message}`);
    return getCached('codex', 30 * 60 * 1000) ??
      { label, short: 'Codex ✕', detail: 'Codex: error', maxPct: 0 };
  }
}

// ─── GitHub Copilot ───────────────────────────────────────────────────────────

/**
 * Try to get a GitHub token via VS Code authentication API.
 * Attempts multiple scope sets because existing sessions may have different scopes.
 */
async function getVscodeGitHubToken(): Promise<string | null> {
  const scopeSets: string[][] = [
    ['user:email', 'read:user'],
    ['read:user'],
    ['user'],
  ];

  for (const scopes of scopeSets) {
    try {
      const session = await vscode.authentication.getSession('github', scopes, { silent: true });
      if (session) {
        log(`Copilot: got VS Code auth token with scopes [${scopes.join(', ')}]`);
        return session.accessToken;
      }
    } catch (e) {
      log(`Copilot: getSession([${scopes.join(', ')}]) failed: ${(e as Error).message}`);
    }
  }
  return null;
}

/**
 * Fallback: read GitHub token from the `gh` CLI config.
 * Works in WSL, remote, codespaces — anywhere `gh` is authenticated.
 */
async function getGhCliToken(): Promise<string | null> {
  // Fast path: `gh auth token` command
  const tokenFromCmd = await runCommand('gh auth token', 5000);
  if (tokenFromCmd && /^(ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(tokenFromCmd)) {
    log(`Copilot: got token from gh CLI command`);
    return tokenFromCmd;
  }

  // Fallback: parse hosts.yml directly
  const hostsPath = findHomeFile(path.join('.config', 'gh', 'hosts.yml'));
  if (hostsPath) {
    try {
      const raw = fs.readFileSync(hostsPath, 'utf-8');
      const match = raw.match(/oauth_token:\s*(\S+)/);
      if (match?.[1]) {
        log(`Copilot: got token from ${hostsPath}`);
        return match[1];
      }
    } catch { /* silent */ }
  }
  return null;
}

async function fetchCopilotSegment(): Promise<ProviderSegment> {
  const label = 'Copilot';
  try {
    // Strategy 1: VS Code authentication API
    let token = await getVscodeGitHubToken();

    // Strategy 2: gh CLI token (works in WSL, remote, codespaces)
    if (!token) {
      log('Copilot: VS Code auth returned no session, trying gh CLI...');
      token = await getGhCliToken();
    }

    if (!token) {
      return { label, short: 'Copilot ⚠', detail: 'Copilot: sign in to GitHub (VS Code or `gh auth login`)', maxPct: 0 };
    }

    const response = await fetchWithTimeout('https://api.github.com/copilot_internal/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'X-GitHub-Api-Version': '2025-05-01',
        'User-Agent': 'ai-usage-bar-vscode',
      },
    }, 12000);

    if (!response.ok) {
      log(`Copilot API ${response.status}`);
      if (response.status === 401) {
        return { label, short: 'Copilot ✕', detail: 'Copilot: token expired (re-authenticate)', maxPct: 0 };
      }
      return { label, short: 'Copilot ✕', detail: `Copilot: API error ${response.status}`, maxPct: 0 };
    }

    const data = (await response.json()) as CopilotUserInfo;
    const pi = data.quota_snapshots?.premium_interactions;

    if (!pi) {
      const plan = data.copilot_plan ?? 'unknown';
      return { label, short: 'Copilot --', detail: `Copilot (${plan}): no quota data`, maxPct: 0 };
    }

    if (pi.unlimited) {
      return { label, short: 'Copilot ∞', detail: 'Copilot: unlimited plan', maxPct: 0 };
    }

    const used = Math.round(pi.entitlement * (1 - pi.percent_remaining / 100));
    const pct = pi.entitlement > 0 ? Math.round((used / pi.entitlement) * 1000) / 10 : 0;

    const resetDate = data.quota_reset_date
      ? new Date(data.quota_reset_date)
      : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
    const resetStr = formatCountdown(resetDate);

    const short = `Copilot ${emojiPct(pct)}`;
    const detail = `Copilot ${renderBar(pct)} ${used}/${pi.entitlement} (${coloredPct(pct)}) resets ${resetStr}`;

    const segment: ProviderSegment = { label, short, detail, maxPct: pct };
    setCache('copilot', segment);
    return segment;
  } catch (err) {
    log(`Copilot fetch error: ${(err as Error).message}`);
    return getCached('copilot', 30 * 60 * 1000) ??
      { label, short: 'Copilot ✕', detail: 'Copilot: fetch error', maxPct: 0 };
  }
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);
  debugLogsEnabled = vscode.workspace.getConfiguration().get<boolean>('aiUsage.debugLogs', false);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(sync~spin) AI Usage…';
  statusBar.tooltip = 'AI Usage Bar – loading…';
  statusBar.command = 'aiUsage.refresh';
  statusBar.show();
  context.subscriptions.push(statusBar);

  logAlways(`AI Usage Bar activated (platform: ${process.platform}, WSL: ${isWsl()}, home: ${os.homedir()})`);

  let polling = false;

  async function refresh(): Promise<void> {
    if (polling) { return; }
    polling = true;
    statusBar.text = '$(sync~spin) Refreshing…';

    try {
      const providers = getProviderConfig();
      if (!providers.claude && !providers.codex && !providers.copilot) {
        statusBar.backgroundColor = undefined;
        statusBar.color = undefined;
        statusBar.text = '$(circle-slash) AI Usage: no providers enabled';
        statusBar.tooltip = 'Enable at least one provider in settings: aiUsage.providers.*';
        return;
      }

      const [claude, codex, copilot] = await Promise.all([
        providers.claude ? fetchClaudeSegment() : Promise.resolve(disabledSegment('Claude')),
        providers.codex ? fetchCodexSegment() : Promise.resolve(disabledSegment('Codex')),
        providers.copilot ? fetchCopilotSegment() : Promise.resolve(disabledSegment('Copilot')),
      ]);

      const maxPct = Math.max(claude.maxPct, codex.maxPct, copilot.maxPct);

      statusBar.backgroundColor = undefined;
      statusBar.color = undefined;

      const enabledShorts = [
        providers.claude ? claude.short : null,
        providers.codex ? codex.short : null,
        providers.copilot ? copilot.short : null,
      ].filter((s): s is string => Boolean(s));
      statusBar.text = `$(pulse) ${enabledShorts.join(' | ')}`;

      const ext = vscode.extensions.getExtension('ai-usage-bar.ai-usage-bar');
      const version = ext?.packageJSON?.version ?? '?';
      const tip = new vscode.MarkdownString('', true);
      tip.isTrusted = true;
      tip.supportHtml = true;
      tip.appendMarkdown(`**AI Usage Bar v${version}** &mdash; _${new Date().toLocaleTimeString()}_\n\n`);
      tip.appendMarkdown(`---\n\n`);
      if (providers.claude) { tip.appendMarkdown(`&nbsp;&nbsp;**Claude** &nbsp; ${claude.detail}\n\n`); }
      if (providers.codex) { tip.appendMarkdown(`&nbsp;&nbsp;**Codex** &nbsp;&nbsp; ${codex.detail}\n\n`); }
      if (providers.copilot) { tip.appendMarkdown(`&nbsp;&nbsp;**Copilot** &nbsp; ${copilot.detail}\n\n`); }
      tip.appendMarkdown(`---\n\n`);
      tip.appendMarkdown(`_Click to refresh &nbsp;|&nbsp; Configure providers with aiUsage.providers.* settings_`);
      statusBar.tooltip = tip;

      log(`Refresh done – Claude:${Math.round(claude.maxPct)}% Codex:${Math.round(codex.maxPct)}% Copilot:${Math.round(copilot.maxPct)}%`);
    } catch (err) {
      log(`Unexpected error: ${(err as Error).message}`);
    } finally {
      polling = false;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiUsage.refresh', () => void refresh()),
    vscode.commands.registerCommand('aiUsage.signInGitHub', async () => {
      try {
        const session = await vscode.authentication.getSession(
          'github', ['user:email', 'read:user'], { createIfNone: true }
        );
        if (session) {
          vscode.window.showInformationMessage(`AI Usage Bar: signed in as ${session.account.label}`);
          void refresh();
        }
      } catch {
        vscode.window.showErrorMessage('AI Usage Bar: GitHub sign-in failed');
      }
    }),
    vscode.commands.registerCommand('aiUsage.toggleClaude', async () => {
      const cfg = vscode.workspace.getConfiguration();
      const next = !cfg.get<boolean>('aiUsage.providers.claude', true);
      await cfg.update('aiUsage.providers.claude', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`AI Usage Bar: Claude ${next ? 'enabled' : 'disabled'}`);
      void refresh();
    }),
    vscode.commands.registerCommand('aiUsage.toggleCodex', async () => {
      const cfg = vscode.workspace.getConfiguration();
      const next = !cfg.get<boolean>('aiUsage.providers.codex', true);
      await cfg.update('aiUsage.providers.codex', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`AI Usage Bar: Codex ${next ? 'enabled' : 'disabled'}`);
      void refresh();
    }),
    vscode.commands.registerCommand('aiUsage.toggleCopilot', async () => {
      const cfg = vscode.workspace.getConfiguration();
      const next = !cfg.get<boolean>('aiUsage.providers.copilot', true);
      await cfg.update('aiUsage.providers.copilot', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`AI Usage Bar: Copilot ${next ? 'enabled' : 'disabled'}`);
      void refresh();
    })
  );

  void refresh();

  function startInterval(): NodeJS.Timeout {
    const raw: number = vscode.workspace.getConfiguration().get('aiUsage.refreshSeconds', 120);
    return setInterval(() => void refresh(), Math.max(30, raw) * 1000);
  }

  let timer = startInterval();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiUsage.debugLogs')) {
        debugLogsEnabled = vscode.workspace.getConfiguration().get<boolean>('aiUsage.debugLogs', false);
      }
      if (
        e.affectsConfiguration('aiUsage.refreshSeconds') ||
        e.affectsConfiguration('aiUsage.providers.claude') ||
        e.affectsConfiguration('aiUsage.providers.codex') ||
        e.affectsConfiguration('aiUsage.providers.copilot')
      ) {
        clearInterval(timer);
        timer = startInterval();
        void refresh();
      }
    }),
    { dispose: () => clearInterval(timer) }
  );
}

export function deactivate(): void {}
