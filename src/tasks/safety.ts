/**
 * High-risk shell / destructive pattern detection.
 * Covers both Unix/Linux and Windows (cmd.exe + PowerShell) scenarios.
 * Used to reject prompts that could cause irreversible damage before they
 * reach OpenCode.
 */

const HIGH_RISK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // ── Unix/Linux ──────────────────────────────────────────────────────────────
  { re: /\brm\s+-[a-z]*r[a-z]*f\b/i,  reason: 'rm -rf (recursive force delete)' },
  { re: /\bdd\s+if=/i,                 reason: 'dd (raw disk write)' },
  { re: />\s*\/dev\/sd[a-z]/i,         reason: 'write to block device' },
  { re: /\bfdisk\b/i,                  reason: 'fdisk (disk partitioning)' },
  { re: /\bmkfs\b/i,                   reason: 'mkfs (format filesystem)' },
  { re: /\bchmod\s+[0-7]*7\s*\/\b/i,  reason: 'chmod on root (permission blast)' },
  { re: /\bpoweroff\b/i,               reason: 'poweroff' },
  { re: /\bkill\s+-9\s+1\b/i,         reason: 'kill -9 PID 1 (init)' },

  // ── Windows cmd.exe ─────────────────────────────────────────────────────────
  { re: /\brd\s+\/s\b/i,              reason: 'rd /s (recursive directory delete)' },
  { re: /\brmdir\s+\/s\b/i,           reason: 'rmdir /s (recursive directory delete)' },
  { re: /\bdel\s+\/[fqs]/i,           reason: 'del /f /q /s (force delete)' },
  { re: /\bformat\s+[a-z]:\b/i,       reason: 'format drive (Windows)' },
  { re: /\bdiskpart\b/i,              reason: 'diskpart (disk partitioning)' },
  { re: /\bbcdedit\b/i,               reason: 'bcdedit (boot config editor)' },
  { re: /\breg\s+(delete|add)\b/i,    reason: 'reg delete/add (registry modification)' },
  { re: /\bnet\s+user\b/i,            reason: 'net user (user account modification)' },
  { re: /\bnet\s+localgroup\b/i,      reason: 'net localgroup (group modification)' },
  { re: /\bicacls\s+.*\/grant/i,      reason: 'icacls /grant (set permissions)' },
  { re: /\bcacls\s+.*\/t\s+.*\/g\s+.*:f/i, reason: 'cacls full-access tree' },
  { re: /\btakeown\b/i,               reason: 'takeown (take file ownership)' },
  { re: /\bsc\s+(delete|stop|create)\b/i, reason: 'sc delete/stop/create (service control)' },
  { re: /\bcipher\s+\/[wd]/i,         reason: 'cipher /w or /d (wipe/decrypt)' },
  { re: /\bshutdown\s+\/[srfh]/i,     reason: 'shutdown (Windows)' },

  // ── PowerShell ──────────────────────────────────────────────────────────────
  { re: /Remove-Item\s+.*-Recurse/i,  reason: 'Remove-Item -Recurse (PS recursive delete)' },
  { re: /\bFormat-Volume\b/i,         reason: 'Format-Volume (PS format disk)' },
  { re: /\bInvoke-Expression\b/i,     reason: 'Invoke-Expression (PS eval)' },
  { re: /(?<![A-Za-z])\biex\b/i,     reason: 'iex (Invoke-Expression alias)' },
  { re: /Start-Process\s+.*-Verb\s+RunAs/i, reason: 'Start-Process RunAs (PS privilege escalation)' },
  { re: /\bSet-ExecutionPolicy\s+Unrestricted/i, reason: 'Set-ExecutionPolicy Unrestricted' },
  { re: /\bDisable-WindowsDefender\b/i, reason: 'Disable-WindowsDefender' },
  { re: /Set-MpPreference\s+.*DisableRealtimeMonitoring/i, reason: 'Disable Windows Defender real-time' },

  // ── SQL ─────────────────────────────────────────────────────────────────────
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: 'SQL DROP' },
  { re: /\bTRUNCATE\s+TABLE\b/i,      reason: 'SQL TRUNCATE TABLE' },

  // ── Generic injection guards ────────────────────────────────────────────────
  { re: /\x00/,                        reason: 'null byte in prompt' },
];

export interface SafetyResult {
  blocked: boolean;
  reason?: string;
}

export function isHighRisk(prompt: string): SafetyResult {
  for (const { re, reason } of HIGH_RISK_PATTERNS) {
    if (re.test(prompt)) {
      return { blocked: true, reason };
    }
  }
  return { blocked: false };
}
