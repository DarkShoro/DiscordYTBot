import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configuredYtDlpPath = process.env.YTDLP_PATH?.trim();
const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const projectRoot = resolve(currentDir, '..', '..');
const projectBinDir = resolve(projectRoot, 'bin');
const configuredCookiesPath = process.env.YTDLP_COOKIES_PATH?.trim();
const defaultCookiesPath = resolve(projectBinDir, 'cookies.txt');
const cookiesPath = configuredCookiesPath || defaultCookiesPath;

const localBinCandidates =
  process.platform === 'win32'
    ? [resolve(projectBinDir, 'yt-dlp.exe'), resolve(projectBinDir, 'yt-dlp')]
    : [resolve(projectBinDir, 'yt-dlp')];

const ytdlpCandidates = configuredYtDlpPath
  ? [configuredYtDlpPath]
  : process.platform === 'win32'
    ? [...localBinCandidates, 'yt-dlp.exe', 'yt-dlp']
    : [...localBinCandidates, 'yt-dlp'];
const ytdlpDefaultArgs = ['--ignore-config'];

function formatCommand(binary, args) {
  const escapedArgs = args.map((arg) => {
    if (/\s|"/.test(arg)) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }

    return arg;
  });

  return [binary, ...escapedArgs].join(' ');
}

function withCookies(args) {
  if (!existsSync(cookiesPath)) {
    return args;
  }

  return ['--cookies', cookiesPath, ...args];
}

function runWithBinary(binary, args) {
  return new Promise((resolve, reject) => {
    const commandText = formatCommand(binary, args);
    console.log(`[yt-dlp] ${commandText}`);

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      const wrappedError = new Error(`Failed to start yt-dlp at "${binary}": ${error.message}`);
      wrappedError.code = error.code;
      reject(wrappedError);
    });

    child.on('close', (code) => {
      console.log(`[yt-dlp] exit code ${code} (${binary})`);

      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(`yt-dlp exited with code ${code} using "${binary}". stderr: ${stderr.trim() || 'no stderr output'}`),
      );
    });
  });
}

export async function runYtDlp(args) {
  const finalArgs = withCookies([...ytdlpDefaultArgs, ...args]);
  let lastError = null;

  for (let i = 0; i < ytdlpCandidates.length; i += 1) {
    const candidate = ytdlpCandidates[i];

    try {
      return await runWithBinary(candidate, finalArgs);
    } catch (error) {
      lastError = error;

      const isLastCandidate = i === ytdlpCandidates.length - 1;
      const notFound = error?.code === 'ENOENT';

      if (notFound && !isLastCandidate) {
        console.warn(`[yt-dlp] binary not found at "${candidate}", trying fallback...`);
        continue;
      }

      break;
    }
  }

  throw lastError;
}

export function normalizeTrackInfo(raw) {
  if (raw?.entries?.length) {
    const first = raw.entries.find((entry) => Boolean(entry));
    return first || null;
  }

  return raw || null;
}

export function normalizeDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'unknown';
  }

  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }

  return `${minutes}:${ss}`;
}
