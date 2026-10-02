import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();

test('mandatory machine discovery files exist in public/', () => {
  const requiredFiles = [
    'public/llms.txt',
    'public/AGENTS.md',
    'public/.well-known/unlinked.json',
    'public/.well-known/mcp/server-card.json',
    'public/openapi.json',
    'public/robots.txt',
    'public/sitemap.xml',
    'AGENTS.md',
    'CLAUDE.md',
    'src/app/agents/page.tsx',
  ];

  for (const file of requiredFiles) {
    const fullPath = path.join(ROOT_DIR, file);
    assert.ok(fs.existsSync(fullPath), `Expected ${file} to exist`);
  }

  // Ensure no conflicting or redundant descriptors exist
  assert.ok(
    !fs.existsSync(path.join(ROOT_DIR, 'public/.well-known/unlinked-ai.json')),
    'public/.well-known/unlinked-ai.json should not exist (canonical is unlinked.json)'
  );
});

test('public/.well-known/mcp/server-card.json describes canonical account MCP', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/mcp/server-card.json'), 'utf8');
  const card = JSON.parse(content);

  assert.equal(card.name, 'unlinked');
  assert.equal(card.version, '1.0.0');
  assert.equal(card.homepage, 'https://www.unlinked.ai');
  assert.equal(card.transports?.['streamable-http']?.url, 'https://www.unlinked.ai/mcp');
  assert.equal(card.authentication?.type, 'bearer');
  assert.equal(card.authentication?.setupUrl, 'https://www.unlinked.ai/settings');
  assert.ok(!card.transports?.stdio, 'canonical card must not advertise legacy stdio bootstrap');

  const toolNames = card.tools.map((t) => t.name);
  assert.deepEqual(toolNames, ['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ask']);
  const searchTool = card.tools[0];
  assert.deepEqual(searchTool.inputSchema.required, ['query']);
  assert.equal(searchTool.inputSchema.additionalProperties, false);
  assert.equal(searchTool.inputSchema.properties.query.type, 'string');
  assert.equal(searchTool.inputSchema.properties.query.minLength, 1);
  assert.equal(searchTool.inputSchema.properties.query.maxLength, 1024);
});

test('public/.well-known/unlinked.json product descriptor is valid', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/unlinked.json'), 'utf8');
  const descriptor = JSON.parse(content);

  assert.equal(descriptor.name, 'Unlinked');
  assert.equal(descriptor.homepage, 'https://www.unlinked.ai');
  assert.equal(descriptor.login, 'https://www.unlinked.ai/login');
  assert.equal(descriptor.importInstructions, 'https://www.unlinked.ai/import-linkedin');
  assert.equal(descriptor.agentSetup, 'https://www.unlinked.ai/settings');
  assert.equal(descriptor.authentication.browser, 'Ideaflow ID issuer/subject');
  assert.equal(descriptor.authentication.mcp, 'revocable account-scoped bearer grant');
  assert.equal(descriptor.data.ownNetwork, true);
  assert.equal(descriptor.data.globalSearch, true);
  assert.equal(descriptor.data.rawArchiveAgentAccess, false);
  assert.equal(descriptor.mcp.url, 'https://www.unlinked.ai/mcp');
  assert.equal(descriptor.mcp.transport, 'streamable-http');
  assert.deepEqual(descriptor.mcp.tools, ['unlinked_search_network', 'unlinked_search_everyone', 'unlinked_whoami', 'unlinked_list_people', 'unlinked_list_connections', 'unlinked_get_profile', 'unlinked_ask']);
});

test('machine-readable MCP config never advertises legacy local launch bootstrap', () => {
  const card = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/mcp/server-card.json'), 'utf8'));
  const descriptor = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/unlinked.json'), 'utf8'));
  const launchValues = [
    JSON.stringify(card),
    JSON.stringify(descriptor),
  ].filter(Boolean);
  for (const value of launchValues) {
    assert.ok(!/\bnpx\b/.test(value), `launch config must not use npx: ${value}`);
    assert.ok(!value.includes('github:'), `launch config must not use github: specifiers: ${value}`);
    assert.ok(!value.includes('dist/index.js'), `launch config must not point at a local stdio build: ${value}`);
    assert.ok(!value.includes('UNLINKED_API_KEY'), `launch config must not advertise legacy ul_ env setup: ${value}`);
  }
});

test('public/openapi.json describes canonical beta routes accurately', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/openapi.json'), 'utf8');
  const spec = JSON.parse(content);

  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'Unlinked canonical beta');
  assert.equal(spec.info.version, '1.0.0');
  assert.equal(spec.servers[0].url, 'https://www.unlinked.ai');

  const paths = Object.keys(spec.paths);
  const expectedPaths = ['/login', '/mcp', '/api/people', '/api/people/{id}', '/api/my-connections', '/api/legacy-files', '/legacy-files/{objectId}', '/api/agent/v1/whoami', '/api/agent/v1/people', '/api/agent/v1/people/{id}', '/api/agent/v1/connections', '/api/agent/v1/ask', '/api/agent/v1/search-network', '/api/agent/v1/search-everyone'];

  for (const p of expectedPaths) {
    assert.ok(paths.includes(p), `Expected openapi.json to include path ${p}`);
  }
  assert.deepEqual(paths.sort(), expectedPaths.sort());

  assert.ok(!paths.includes('/api/cron/embed'), 'cron/embed must NOT be in openapi.json');
  assert.equal(spec.paths['/login'].get.responses['303'].description, 'Redirect to verified provider');
  assert.equal(spec.paths['/mcp'].post.summary, 'Streamable HTTP MCP, account-scoped bearer');
  assert.deepEqual(spec.paths['/mcp'].post.security, [{ accountGrant: [] }]);
  assert.equal(spec.paths['/mcp'].post.responses['401'].description, 'Missing, invalid or revoked account grant');
  assert.deepEqual(spec.paths['/api/legacy-files'].get.security, [{ browserSession: [] }]);
  assert.deepEqual(spec.paths['/legacy-files/{objectId}'].get.security, [{ browserSession: [] }]);
  assert.equal(spec.components.securitySchemes.accountGrant.type, 'http');
  assert.equal(spec.components.securitySchemes.accountGrant.scheme, 'bearer');
  assert.equal(spec.components.securitySchemes.browserSession.type, 'apiKey');
});

test('public/llms.txt conforms to specification', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/llms.txt'), 'utf8');

  assert.ok(content.startsWith('# Unlinked'), 'Must start with # Unlinked');
  assert.ok(content.includes('> Import a LinkedIn export, search your own network and connect your agent.'), 'Must contain current blockquote');
  assert.ok(content.includes('(/agents)'), 'Must link to /agents');
  assert.ok(content.includes('(/AGENTS.md)'), 'Must link to /AGENTS.md');
  assert.ok(content.includes('(/.well-known/unlinked.json)'), 'Must link to unlinked.json');
  assert.ok(content.includes('(/.well-known/mcp/server-card.json)'), 'Must link to server-card.json');
  assert.ok(content.includes('(/openapi.json)'), 'Must link to openapi.json');
  assert.ok(content.includes('Streamable HTTP endpoint: https://www.unlinked.ai/mcp'), 'Must describe canonical MCP endpoint');
  assert.ok(content.includes('unlinked_search_network'), 'Must mention current MCP tool');
  assert.ok(content.includes('Everyone People browsing reads only the published professional index'), 'Must state public index scope');
  assert.ok(content.includes('Legacy Supabase routes and stdio tools are historical'), 'Must identify legacy setup as historical');
});

test('public/robots.txt allows AI discovery and is conservative about profile pages', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/robots.txt'), 'utf8');

  assert.ok(content.includes('User-agent: GPTBot'), 'Must mention GPTBot');
  assert.ok(content.includes('User-agent: ClaudeBot'), 'Must mention ClaudeBot');
  assert.ok(content.includes('User-agent: PerplexityBot'), 'Must mention PerplexityBot');
  assert.ok(content.includes('Disallow: /profiles'), 'Must disallow /profiles');
  assert.ok(content.includes('Disallow: /profiles/'), 'Must disallow /profiles/');
  assert.ok(content.includes('Allow: /llms.txt'), 'Must allow /llms.txt');
  assert.ok(content.includes('Allow: /AGENTS.md'), 'Must allow /AGENTS.md');
  assert.ok(content.includes('Allow: /.well-known/'), 'Must allow /.well-known/');
  assert.ok(content.includes('Allow: /openapi.json'), 'Must allow /openapi.json');
  assert.ok(content.includes('Allow: /agents'), 'Must allow /agents');
  assert.ok(content.includes('Sitemap: https://www.unlinked.ai/sitemap.xml'), 'Must declare sitemap');
});

test('public/sitemap.xml contains expected canonical URLs', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/sitemap.xml'), 'utf8');

  assert.ok(content.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  const urls = [
    'https://www.unlinked.ai/',
    'https://www.unlinked.ai/agents',
    'https://www.unlinked.ai/llms.txt',
    'https://www.unlinked.ai/AGENTS.md',
    'https://www.unlinked.ai/openapi.json',
  ];
  for (const url of urls) {
    assert.ok(content.includes(`<loc>${url}</loc>`), `Expected sitemap to include ${url}`);
  }
});

test('root AGENTS.md and public/AGENTS.md are distinct audiences with proper governance', () => {
  const rootAgents = fs.readFileSync(path.join(ROOT_DIR, 'AGENTS.md'), 'utf8');
  const publicAgents = fs.readFileSync(path.join(ROOT_DIR, 'public/AGENTS.md'), 'utf8');

  assert.notEqual(rootAgents, publicAgents, 'Root AGENTS.md and public/AGENTS.md must not be identical');
  assert.ok(rootAgents.includes('## Maintaining this file'), 'Root AGENTS.md must include canonical maintenance section');
  assert.ok(publicAgents.includes('# Unlinked agent guide'), 'Public AGENTS.md must identify as HTTP agent guide');
  assert.ok(publicAgents.includes('Anonymous discovery, professional People browsing and Meet are public'), 'Public AGENTS.md must state public/protected boundary');

  const claudePointer = fs.readFileSync(path.join(ROOT_DIR, 'CLAUDE.md'), 'utf8');
  assert.ok(claudePointer.includes('@AGENTS.md'), 'CLAUDE.md must point to AGENTS.md');
});

test('no secrets or internal credentials in public files', () => {
  const publicDir = path.join(ROOT_DIR, 'public');
  const files = fs.readdirSync(publicDir, { recursive: true, withFileTypes: true });

  for (const file of files) {
    if (!file.isFile()) continue;
    const fullPath = path.join(file.parentPath || file.path, file.name);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Reject real service role key formats, private keys, or actual user passwords
    assert.ok(!content.includes('SUPABASE_SERVICE_ROLE_KEY'), `Found secret reference in ${file.name}`);
    assert.ok(!content.includes('eyJh'), `Found potential JWT in ${file.name}`);
    assert.ok(!/ul_[a-zA-Z0-9_-]{20,}/.test(content), `Found real-looking agent key in ${file.name}`);
  }
});
