import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeploymentConfigError,
  validateDeployConfig,
  validateEnvironment,
} from '../scripts/check-deploy-config.mjs';

function validConfig(overrides = {}) {
  const values = {
    staging: {
      workerName: 'reitaisai-api-staging',
      frontendUrl: 'https://staging-app.festival.jp',
      allowedOrigin: 'https://staging-app.festival.jp',
      siteDomain: 'festival.jp',
      discordClientId: '111111111111111111',
      redirectUri: 'https://staging-api.festival.jp/api/auth/discord/callback',
      databaseId: '11111111-1111-1111-1111-111111111111',
      routePattern: 'staging-api.festival.jp',
      customDomain: true,
      ...overrides.staging,
    },
    production: {
      workerName: 'reitaisai-api-production',
      frontendUrl: 'https://app.festival.jp',
      allowedOrigin: 'https://app.festival.jp',
      siteDomain: 'festival.jp',
      discordClientId: '222222222222222222',
      redirectUri: 'https://api.festival.jp/api/auth/discord/callback',
      databaseId: '22222222-2222-2222-2222-222222222222',
      routePattern: 'api.festival.jp',
      customDomain: true,
      ...overrides.production,
    },
  };

  return ['staging', 'production'].map((name) => {
    const env = values[name];
    return `
[env.${name}]
name = "${env.workerName}"

[env.${name}.vars]
ALLOWED_ORIGINS = "${env.allowedOrigin}"
FRONTEND_URL = "${env.frontendUrl}"
SESSION_SITE_DOMAIN = "${env.siteDomain}"
DISCORD_CLIENT_ID = "${env.discordClientId}"
DISCORD_REDIRECT_URI = "${env.redirectUri}"

[[env.${name}.d1_databases]]
database_id = "${env.databaseId}"

[[env.${name}.routes]]
pattern = "${env.routePattern}"
custom_domain = ${env.customDomain}
`;
  }).join('\n');
}

function rejects(config, pattern) {
  assert.throws(
    () => validateDeployConfig(config),
    (error) => error instanceof DeploymentConfigError && pattern.test(error.message),
  );
}

test('accepts separated staging and production configuration', () => {
  assert.equal(validateDeployConfig(validConfig()).length, 2);
});

test('staging validation ignores unfinished production placeholders', () => {
  const config = validConfig({
    production: {
      workerName: 'replace-with-production-worker-name',
      frontendUrl: 'https://app.example.com',
      allowedOrigin: 'https://app.example.com',
      siteDomain: 'example.com',
      discordClientId: 'replace-with-production-discord-client-id',
      redirectUri: 'https://api.example.com/api/auth/discord/callback',
      databaseId: 'replace-with-production-database-id',
      routePattern: 'api.example.com',
    },
  });

  assert.equal(validateEnvironment(config, 'staging').workerName, 'reitaisai-api-staging');
  rejects(config, /プレースホルダー/);
});

test('environment validation remains strict for the selected environment', () => {
  assert.throws(
    () => validateEnvironment(validConfig({ staging: { databaseId: 'replace-with-staging-database-id' } }), 'staging'),
    (error) => error instanceof DeploymentConfigError && /staging.*プレースホルダー/.test(error.message),
  );
});

test('rejects values shared by staging and production', async (t) => {
  const cases = [
    ['Worker name', { production: { workerName: 'REITAISAI-API-STAGING' } }, /同じWorker name/],
    ['Worker Custom Domain', {
      production: {
        routePattern: 'staging-api.festival.jp',
        redirectUri: 'https://staging-api.festival.jp/api/auth/discord/callback',
      },
    }, /同じWorker Custom Domain/],
    ['FRONTEND_URL origin', {
      production: {
        frontendUrl: 'https://staging-app.festival.jp/production-path',
        allowedOrigin: 'https://staging-app.festival.jp',
      },
    }, /同じFRONTEND_URLのorigin/],
    ['Discord client', { production: { discordClientId: '111111111111111111' } }, /同じDISCORD_CLIENT_ID/],
    ['D1 database', { production: { databaseId: '11111111-1111-1111-1111-111111111111' } }, /同じD1/],
  ];

  for (const [name, overrides, pattern] of cases) {
    await t.test(name, () => rejects(validConfig(overrides), pattern));
  }
});

test('rejects unsafe SESSION_SITE_DOMAIN values', async (t) => {
  const cases = [
    ['single label', 'localhost'],
    ['top-level public suffix', 'com'],
    ['multi-label public suffix', 'co.jp'],
    ['shared hosting suffix', 'pages.dev'],
    ['IP address', '127.0.0.1'],
  ];

  for (const [name, siteDomain] of cases) {
    await t.test(name, () => {
      const config = validConfig({
        staging: {
          siteDomain,
          frontendUrl: `https://${siteDomain}`,
          allowedOrigin: `https://${siteDomain}`,
          redirectUri: `https://${siteDomain}/api/auth/discord/callback`,
          routePattern: siteDomain,
        },
      });
      rejects(config, /SESSION_SITE_DOMAIN/);
    });
  }
});

test('requires frontend and API hosts to be inside SESSION_SITE_DOMAIN', () => {
  rejects(validConfig({ staging: { siteDomain: 'another-festival.jp' } }), /同じSESSION_SITE_DOMAIN配下/);
});

test('requires an actual Worker Custom Domain route', () => {
  rejects(validConfig({ staging: { customDomain: false } }), /custom_domain = true/);
});

test('rejects malformed Discord and D1 identifiers', async (t) => {
  await t.test('Discord client ID', () => {
    rejects(validConfig({ staging: { discordClientId: 'not-a-snowflake' } }), /DISCORD_CLIENT_IDが正しくありません/);
  });
  await t.test('D1 database ID', () => {
    rejects(validConfig({ staging: { databaseId: '------------------------------------' } }), /D1 database_idが正しくありません/);
  });
});
