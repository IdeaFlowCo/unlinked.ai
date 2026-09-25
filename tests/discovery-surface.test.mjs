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

test('public/.well-known/mcp/server-card.json is valid and matches MCP server tools', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/mcp/server-card.json'), 'utf8');
  const card = JSON.parse(content);

  assert.equal(card.name, 'unlinked');
  assert.equal(card.package, '@unlinked/mcp-server');
  assert.equal(card.version, '0.1.0');
  assert.ok(card.transports?.stdio, 'stdio transport must be defined');
  // The server is not published to npm, so the advertised launch must be the local build:
  // `node <clone>/mcp-server/dist/index.js`, matching the package's own bin/start entrypoint.
  const stdio = card.transports.stdio;
  assert.equal(stdio.command, 'node');
  assert.equal(stdio.args.length, 1);
  const mcpPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'mcp-server/package.json'), 'utf8'));
  const entrypoint = path.posix.join('mcp-server', mcpPkg.bin['unlinked-mcp-server']);
  assert.ok(stdio.args[0].endsWith(`/${entrypoint}`), `stdio arg must point at ${entrypoint}`);
  assert.equal(stdio.setup.entrypoint, entrypoint);

  const toolNames = card.tools.map((t) => t.name);
  const expectedTools = [
    'unlinked_me',
    'unlinked_search_contacts',
    'unlinked_get_profile',
    'unlinked_list_imports',
    'unlinked_draft_intro',
  ];
  assert.deepEqual(toolNames.sort(), expectedTools.sort());

  // Verify against mcp-server/src/server.ts
  const serverSource = fs.readFileSync(path.join(ROOT_DIR, 'mcp-server/src/server.ts'), 'utf8');
  for (const expectedTool of expectedTools) {
    assert.ok(
      serverSource.includes(`"${expectedTool}"`) || serverSource.includes(`'${expectedTool}'`),
      `Expected ${expectedTool} to be registered in mcp-server/src/server.ts`
    );
  }
});

test('public/.well-known/unlinked.json product descriptor is valid', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/unlinked.json'), 'utf8');
  const descriptor = JSON.parse(content);

  assert.equal(descriptor.name, 'unlinked.ai');
  assert.equal(descriptor.site, 'https://www.unlinked.ai');
  assert.equal(descriptor.docs.llms_txt, '/llms.txt');
  assert.equal(descriptor.docs.agents_md, '/AGENTS.md');
  assert.equal(descriptor.docs.agents_page, '/agents');
  assert.equal(descriptor.docs.openapi, '/openapi.json');
  assert.equal(descriptor.docs.mcp_server_card, '/.well-known/mcp/server-card.json');
  assert.equal(descriptor.api.auth.key_prefix, 'ul_');

  const [command, ...args] = descriptor.mcp.command.split(' ');
  assert.equal(command, 'node');
  assert.equal(args.length, 1);
  assert.ok(args[0].endsWith('/mcp-server/dist/index.js'), 'mcp.command must launch the local build');
});

test('machine-readable MCP launch config never advertises the broken npx github: form', () => {
  const card = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/mcp/server-card.json'), 'utf8'));
  const descriptor = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'public/.well-known/unlinked.json'), 'utf8'));
  const launchValues = [
    card.transports.stdio.command,
    ...card.transports.stdio.args,
    ...Object.values(card.transports.stdio.setup),
    descriptor.mcp.command,
    descriptor.mcp.setup,
  ];
  for (const value of launchValues) {
    assert.ok(!/\bnpx\b/.test(value), `launch config must not use npx: ${value}`);
    assert.ok(!value.includes('github:'), `launch config must not use github: specifiers: ${value}`);
  }
});

test('public/openapi.json describes agent routes accurately', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/openapi.json'), 'utf8');
  const spec = JSON.parse(content);

  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'unlinked.ai Agent API');

  const paths = Object.keys(spec.paths);
  const expectedAgentPaths = [
    '/api/me',
    '/api/search-contacts',
    '/api/profiles/{id}',
    '/api/draft-intro',
    '/api/imports',
  ];

  for (const p of expectedAgentPaths) {
    assert.ok(paths.includes(p), `Expected openapi.json to include path ${p}`);
  }

  // Ensure internal cron is NOT published as an agent route
  assert.ok(!paths.includes('/api/cron/embed'), 'cron/embed must NOT be in openapi.json');

  // Verify route files exist for each path
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'src/app/api/me/route.ts')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'src/app/api/search-contacts/route.ts')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'src/app/api/profiles/[id]/route.ts')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'src/app/api/draft-intro/route.ts')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'src/app/api/imports/route.ts')));
});

test('public/llms.txt conforms to specification', () => {
  const content = fs.readFileSync(path.join(ROOT_DIR, 'public/llms.txt'), 'utf8');

  assert.ok(content.startsWith('# unlinked.ai'), 'Must start with # unlinked.ai');
  assert.ok(content.includes('> AI-powered LinkedIn network search'), 'Must contain blockquote');
  assert.ok(content.includes('(/agents)'), 'Must link to /agents');
  assert.ok(content.includes('(/AGENTS.md)'), 'Must link to /AGENTS.md');
  assert.ok(content.includes('(/.well-known/unlinked.json)'), 'Must link to unlinked.json');
  assert.ok(content.includes('(/.well-known/mcp/server-card.json)'), 'Must link to server-card.json');
  assert.ok(content.includes('(/openapi.json)'), 'Must link to openapi.json');
  assert.ok(content.includes('ul_'), 'Must mention ul_ key prefix');
  assert.ok(content.includes('unlinked_me'), 'Must mention unlinked_me tool');
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
  assert.ok(publicAgents.includes('served at `/AGENTS.md`'), 'Public AGENTS.md must identify as HTTP agent brief');

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
