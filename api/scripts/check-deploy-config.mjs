import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = new URL('../wrangler.deploy.toml', import.meta.url);
const ENVIRONMENT_NAMES = ['staging', 'production'];

// This is intentionally a small denylist, not a replacement for the Public
// Suffix List. It catches common values that would make the same-site boundary
// much broader than a domain controlled by this project.
const KNOWN_PUBLIC_OR_HOSTING_SUFFIXES = new Set([
  'ac.jp',
  'ac.uk',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.uk',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.sg',
  'com.tw',
  'edu.au',
  'firebaseapp.com',
  'github.io',
  'go.jp',
  'gov.au',
  'gov.uk',
  'govt.nz',
  'gr.jp',
  'lg.jp',
  'me.uk',
  'ne.jp',
  'net.au',
  'netlify.app',
  'net.nz',
  'or.jp',
  'org.au',
  'org.nz',
  'org.uk',
  'pages.dev',
  'vercel.app',
  'web.app',
  'workers.dev',
]);

export class DeploymentConfigError extends Error {}

function fail(message) {
  throw new DeploymentConfigError(message);
}

function envBlock(text, name) {
  const start = text.indexOf(`[env.${name}]`);
  if (start < 0) fail(`[env.${name}] がありません。`);
  const nextStarts = ENVIRONMENT_NAMES
    .filter((candidate) => candidate !== name)
    .map((candidate) => text.indexOf(`[env.${candidate}]`, start + 1))
    .filter((index) => index >= 0);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : text.length;
  return text.slice(start, end);
}

function value(block, key) {
  return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] || '';
}

function booleanValue(block, key) {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, 'mi'));
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}

function parseUrl(raw, environmentName) {
  if (raw !== raw.trim()) fail(`${environmentName} のURL設定が正しくありません。`);
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) fail(`${environmentName} のURLに認証情報を含めないでください。`);
    return parsed;
  } catch (error) {
    if (error instanceof DeploymentConfigError) throw error;
    fail(`${environmentName} のURL設定が正しくありません。`);
  }
}

function validateSiteDomain(raw, environmentName) {
  if (raw !== raw.trim()) fail(`${environmentName} のSESSION_SITE_DOMAINが正しくありません。`);
  const siteDomain = raw.toLowerCase();
  let parsed;

  try {
    parsed = new URL(`https://${siteDomain}`);
  } catch {
    fail(`${environmentName} のSESSION_SITE_DOMAINが正しくありません。`);
  }

  const labels = siteDomain.split('.');
  const isCanonicalHostname = parsed.hostname === siteDomain && parsed.origin === `https://${siteDomain}`;
  if (!siteDomain || !isCanonicalHostname || isIP(siteDomain) || labels.some((label) => !label)) {
    fail(`${environmentName} のSESSION_SITE_DOMAINが正しくありません。`);
  }
  if (labels.length < 2 || KNOWN_PUBLIC_OR_HOSTING_SUFFIXES.has(siteDomain)) {
    fail(`${environmentName} のSESSION_SITE_DOMAINには所有する独自ドメインを指定してください。`);
  }

  return siteDomain;
}

function requireDifferent(configs, key, label, normalize = (input) => input) {
  const [staging, production] = configs.map((config) => normalize(config[key]));
  if (staging === production) fail(`stagingとproductionで同じ${label}を指定しています。`);
}

export function validateEnvironment(text, name) {
  if (!ENVIRONMENT_NAMES.includes(name)) fail(`検査対象の環境 ${name} はstagingまたはproductionで指定してください。`);

  const block = envBlock(text, name);
  if (/replace-with|example\.com/i.test(block)) fail(`${name} にプレースホルダーが残っています。`);
  if (/DISCORD_CLIENT_SECRET/i.test(block)) fail('Discord Client Secret は設定ファイルへ書かず、Workers Secret に登録してください。');

  const workerName = value(block, 'name');
  const frontendUrl = value(block, 'FRONTEND_URL');
  const allowedOrigin = value(block, 'ALLOWED_ORIGINS');
  const discordClientId = value(block, 'DISCORD_CLIENT_ID');
  const redirectUri = value(block, 'DISCORD_REDIRECT_URI');
  const siteDomain = validateSiteDomain(value(block, 'SESSION_SITE_DOMAIN'), name);
  const databaseId = value(block, 'database_id');
  const routePattern = value(block, 'pattern').toLowerCase();
  const customDomain = booleanValue(block, 'custom_domain');
  const frontend = parseUrl(frontendUrl, name);
  const redirect = parseUrl(redirectUri, name);

  if (!workerName) fail(`${name} のWorker nameを指定してください。`);
  if (!/^\d{17,20}$/.test(discordClientId)) fail(`${name} のDISCORD_CLIENT_IDが正しくありません。`);
  if (frontend.protocol !== 'https:' || redirect.protocol !== 'https:') fail(`${name} はHTTPS URLだけを使用してください。`);

  const inSite = (hostname) => hostname === siteDomain || hostname.endsWith(`.${siteDomain}`);
  if (!inSite(frontend.hostname) || !inSite(redirect.hostname)) fail(`${name} の画面とAPIは同じSESSION_SITE_DOMAIN配下にしてください。`);
  if (allowedOrigin !== frontend.origin) fail(`${name} のALLOWED_ORIGINSはFRONTEND_URLのoriginと完全一致させてください。`);
  if (redirect.pathname !== '/api/auth/discord/callback') fail(`${name} のDiscord callback pathが正しくありません。`);
  if (customDomain !== true) fail(`${name} のWorker routeはcustom_domain = trueにしてください。`);
  if (routePattern !== redirect.hostname.toLowerCase()) fail(`${name} のWorker Custom DomainとDiscord callback hostが一致していません。`);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(databaseId)) fail(`${name} のD1 database_idが正しくありません。`);

  return {
    databaseId,
    discordClientId,
    frontendOrigin: frontend.origin,
    routePattern,
    workerName,
  };
}

export function validateDeployConfig(text) {
  // Keep the public all-environment validator strict across the whole file.
  // The staging-only CLI path intentionally calls validateEnvironment instead,
  // so production placeholders do not block creation of the staging resources.
  if (/replace-with|example\.com/i.test(text)) fail('プレースホルダーが残っています。');
  if (/DISCORD_CLIENT_SECRET/i.test(text)) fail('Discord Client Secret は設定ファイルへ書かず、Workers Secret に登録してください。');

  const configs = ENVIRONMENT_NAMES.map((name) => validateEnvironment(text, name));

  requireDifferent(configs, 'workerName', 'Worker name', (input) => input.toLowerCase());
  requireDifferent(configs, 'routePattern', 'Worker Custom Domain', (input) => input.toLowerCase());
  requireDifferent(configs, 'frontendOrigin', 'FRONTEND_URLのorigin', (input) => input.toLowerCase());
  requireDifferent(configs, 'discordClientId', 'DISCORD_CLIENT_ID');
  requireDifferent(configs, 'databaseId', 'D1', (input) => input.toLowerCase());

  return configs;
}

function runCli() {
  const args = process.argv.slice(2);
  let target = 'all';

  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--env' || !['staging', 'production', 'all'].includes(args[1])) {
      console.error('Deployment config error: 使用法: node scripts/check-deploy-config.mjs [--env staging|production|all]');
      process.exitCode = 1;
      return;
    }
    target = args[1];
  }

  let text;
  try {
    text = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    console.error('Deployment config error: api/wrangler.deploy.toml がありません。wrangler.toml.example をコピーして設定してください。');
    process.exitCode = 1;
    return;
  }

  try {
    if (target === 'staging') {
      validateEnvironment(text, 'staging');
      console.log('Deployment config OK: staging is valid and same-site.');
    } else {
      // Production is intentionally fail-closed: validate both environments
      // and their separation before any production operation.
      validateDeployConfig(text);
      console.log('Deployment config OK: staging/production are valid, separated and same-site.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Deployment config error: ${message}`);
    process.exitCode = 1;
  }
}

const modulePath = resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = process.platform === 'win32'
  ? modulePath.toLowerCase() === invokedPath.toLowerCase()
  : modulePath === invokedPath;

if (isMain) runCli();
