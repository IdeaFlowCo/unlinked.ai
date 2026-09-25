'use client'

import { useState } from 'react'
import {
  Container,
  Flex,
  Box,
  Button,
  Heading,
  Text,
  Card,
  Badge,
  IconButton,
  Table,
  Tabs,
} from '@radix-ui/themes'
import {
  CopyIcon,
  CheckIcon,
  ArrowLeftIcon,
  ExternalLinkIcon,
  LockClosedIcon,
} from '@radix-ui/react-icons'
import Link from 'next/link'

interface CodeBlockProps {
  code: string
  language?: string
}

function CodeBlock({ code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Box
      style={{
        position: 'relative',
        background: 'var(--gray-3)',
        borderRadius: 8,
        border: '1px solid var(--gray-5)',
        overflow: 'hidden',
      }}
    >
      <Flex
        justify="between"
        align="center"
        px="3"
        py="2"
        style={{
          borderBottom: '1px solid var(--gray-4)',
          background: 'var(--gray-2)',
        }}
      >
        <Text size="1" color="gray" weight="medium">
          configuration
        </Text>
        <IconButton
          size="1"
          variant="ghost"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <CheckIcon color="var(--green-9)" />
          ) : (
            <CopyIcon color="var(--gray-11)" />
          )}
        </IconButton>
      </Flex>
      <pre
        style={{
          margin: 0,
          padding: '12px 16px',
          fontSize: 13,
          lineHeight: '1.5',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          overflowX: 'auto',
        }}
      >
        <code>{code}</code>
      </pre>
    </Box>
  )
}

const CLAUDE_CODE_SNIPPET = `claude mcp add unlinked \\
  --env UNLINKED_API_KEY=ul_your_key_here \\
  -- node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js`

const CLAUDE_DESKTOP_SNIPPET = `{
  "mcpServers": {
    "unlinked": {
      "command": "node",
      "args": ["/absolute/path/to/unlinked.ai/mcp-server/dist/index.js"],
      "env": {
        "UNLINKED_API_KEY": "ul_your_key_here"
      }
    }
  }
}`

const CURSOR_CONFIG = `# Cursor Settings -> Features -> MCP -> Add new MCP server
Name: unlinked
Type: command
Command: node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js
Environment: UNLINKED_API_KEY=ul_your_key_here`

const LOCAL_CLONE_SNIPPET = `git clone https://github.com/IdeaFlowCo/unlinked.ai
cd unlinked.ai/mcp-server
npm install && npm run build
# then point your client at: node /absolute/path/to/unlinked.ai/mcp-server/dist/index.js`

const CREDENTIALS_FILE_SNIPPET = `{
  "apiKey": "ul_your_key_here",
  "baseUrl": "https://www.unlinked.ai"
}`

const CURL_SEARCH_SNIPPET = `curl -s -X POST https://www.unlinked.ai/api/search-contacts \\
  -H "Authorization: Bearer ul_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "distributed systems engineers in San Francisco", "limit": 5}'`

export default function ForAgentsPage() {
  return (
    <Container size="3" pt="5" pb="8" px="4">
      <Flex direction="column" gap="5">
        <Flex justify="between" align="center" wrap="wrap" gap="3">
          <Link href="/profiles">
            <Button variant="ghost" size="2">
              <ArrowLeftIcon /> back to profiles
            </Button>
          </Link>
          <Link href="/settings/agent-keys">
            <Button size="2" variant="solid">
              create agent key →
            </Button>
          </Link>
        </Flex>

        <Box>
          <Heading
            size="8"
            style={{
              background:
                'linear-gradient(to right, var(--accent-9), var(--accent-11))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            unlinked.ai for agents
          </Heading>
          <Text as="p" size="3" color="gray" mt="2">
            Model Context Protocol (MCP) server and REST API for autonomous agents,
            Claude Desktop, Claude Code, Cursor, Cline, and custom tools.
          </Text>
        </Box>

        <Card size="3" style={{ borderColor: 'var(--accent-6)' }}>
          <Flex gap="3" align="start">
            <Box pt="1">
              <LockClosedIcon width="20" height="20" color="var(--accent-9)" />
            </Box>
            <Box>
              <Text as="div" weight="bold" size="3">
                Scoped by design
              </Text>
              <Text as="p" size="2" color="gray" mt="1">
                Every tool call is resolved to your own account server-side. An agent key
                can only see your own profile and your direct connections — never
                anyone else&apos;s network. Accessing an unrelated profile returns 404
                to prevent enumeration.
              </Text>
            </Box>
          </Flex>
        </Card>

        <Box>
          <Heading size="5" mb="3">
            30-second setup
          </Heading>
          <Flex direction="column" gap="2">
            <Text size="2">
              <strong>1.</strong> Sign in to unlinked.ai →{' '}
              <Link href="/settings/agent-keys" className="underline">
                Settings → Agent keys
              </Link>{' '}
              → <strong>create key</strong>
            </Text>
            <Text size="2">
              <strong>2.</strong> Copy the key (starts with <Badge color="blue">ul_</Badge>)
            </Text>
            <Text size="2">
              <strong>3.</strong> Build the MCP server from a local clone (see the{' '}
              <strong>Local clone</strong> tab; it is not published to npm), then paste one of
              the configuration snippets below into your client, replacing{' '}
              <code>/absolute/path/to/unlinked.ai</code> with your clone&apos;s path
            </Text>
          </Flex>
        </Box>

        <Box>
          <Heading size="5" mb="3">
            Client configuration
          </Heading>
          <Tabs.Root defaultValue="claude-code">
            <Tabs.List>
              <Tabs.Trigger value="claude-code">Claude Code</Tabs.Trigger>
              <Tabs.Trigger value="claude-desktop">Claude Desktop</Tabs.Trigger>
              <Tabs.Trigger value="cursor">Cursor</Tabs.Trigger>
              <Tabs.Trigger value="local">Local clone</Tabs.Trigger>
            </Tabs.List>

            <Box pt="3">
              <Tabs.Content value="claude-code">
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">
                    Add unlinked.ai directly with the Claude CLI:
                  </Text>
                  <CodeBlock code={CLAUDE_CODE_SNIPPET} />
                </Flex>
              </Tabs.Content>

              <Tabs.Content value="claude-desktop">
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">
                    Add to{' '}
                    <code>
                      ~/Library/Application Support/Claude/claude_desktop_config.json
                    </code>{' '}
                    (macOS) or{' '}
                    <code>%APPDATA%\Claude\claude_desktop_config.json</code> (Windows):
                  </Text>
                  <CodeBlock code={CLAUDE_DESKTOP_SNIPPET} />
                  <Text size="1" color="gray" mt="1">
                    Restart Claude Desktop to load the tools into your prompt session.
                  </Text>
                </Flex>
              </Tabs.Content>

              <Tabs.Content value="cursor">
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">
                    Configure Cursor MCP under Settings → Features → MCP:
                  </Text>
                  <CodeBlock code={CURSOR_CONFIG} />
                </Flex>
              </Tabs.Content>

              <Tabs.Content value="local">
                <Flex direction="column" gap="2">
                  <Text size="2" color="gray">
                    Clone and build the MCP server. Every client snippet runs this
                    local build:
                  </Text>
                  <CodeBlock code={LOCAL_CLONE_SNIPPET} />
                </Flex>
              </Tabs.Content>
            </Box>
          </Tabs.Root>
        </Box>

        <Box>
          <Heading size="5" mb="3">
            Authentication options
          </Heading>
          <Text as="p" size="2" color="gray" mb="3">
            The MCP server and REST API support authentication via environment variables
            or a local credentials file:
          </Text>
          <Flex direction="column" gap="3">
            <Card size="2">
              <Text as="div" weight="bold" size="2">
                1. Environment variable
              </Text>
              <Text size="2" color="gray" mt="1">
                Set <code>UNLINKED_API_KEY=ul_...</code> in your process environment.
              </Text>
            </Card>

            <Card size="2">
              <Text as="div" weight="bold" size="2">
                2. Credentials file
              </Text>
              <Text size="2" color="gray" mt="1">
                Write <code>~/.unlinked/credentials.json</code>:
              </Text>
              <Box mt="2">
                <CodeBlock code={CREDENTIALS_FILE_SNIPPET} />
              </Box>
            </Card>
          </Flex>
        </Box>

        <Box>
          <Heading size="5" mb="3">
            MCP tools roster
          </Heading>
          <Table.Root variant="surface">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Tool</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Parameters</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Description</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              <Table.Row>
                <Table.RowHeaderCell>
                  <code>unlinked_me</code>
                </Table.RowHeaderCell>
                <Table.Cell>none</Table.Cell>
                <Table.Cell>
                  Your own profile plus connection and upload counts.
                </Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.RowHeaderCell>
                  <code>unlinked_search_contacts</code>
                </Table.RowHeaderCell>
                <Table.Cell>
                  <code>query</code> (string), <code>limit</code> (1–25, opt)
                </Table.Cell>
                <Table.Cell>
                  Semantic search over your direct connections only with similarity score
                  and explanation.
                </Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.RowHeaderCell>
                  <code>unlinked_get_profile</code>
                </Table.RowHeaderCell>
                <Table.Cell>
                  <code>profileId</code> (UUID)
                </Table.Cell>
                <Table.Cell>
                  Read a profile — yours or a direct connection&apos;s; anything else is
                  not-found.
                </Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.RowHeaderCell>
                  <code>unlinked_list_imports</code>
                </Table.RowHeaderCell>
                <Table.Cell>none</Table.Cell>
                <Table.Cell>
                  Your LinkedIn archive uploads and ingested-record counts.
                </Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.RowHeaderCell>
                  <code>unlinked_draft_intro</code>
                </Table.RowHeaderCell>
                <Table.Cell>
                  <code>contactProfileId</code> (UUID), <code>context</code> (opt)
                </Table.Cell>
                <Table.Cell>
                  Draft a short, forwardable intro to a direct connection (read-only,
                  nothing is written).
                </Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table.Root>
        </Box>

        <Box>
          <Heading size="5" mb="3">
            REST API
          </Heading>
          <Text as="p" size="2" color="gray" mb="3">
            Any HTTP client can access the unlinked.ai agent surface by sending{' '}
            <code>Authorization: Bearer ul_...</code> to{' '}
            <code>https://www.unlinked.ai</code>:
          </Text>
          <CodeBlock code={CURL_SEARCH_SNIPPET} />
        </Box>

        <Box>
          <Heading size="5" mb="3">
            Machine discovery surfaces
          </Heading>
          <Flex wrap="wrap" gap="2">
            <a href="/llms.txt" target="_blank" rel="noopener noreferrer">
              <Button size="1" variant="soft">
                /llms.txt <ExternalLinkIcon />
              </Button>
            </a>
            <a href="/AGENTS.md" target="_blank" rel="noopener noreferrer">
              <Button size="1" variant="soft">
                /AGENTS.md <ExternalLinkIcon />
              </Button>
            </a>
            <a
              href="/.well-known/unlinked.json"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="1" variant="soft">
                /.well-known/unlinked.json <ExternalLinkIcon />
              </Button>
            </a>
            <a
              href="/.well-known/mcp/server-card.json"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="1" variant="soft">
                /.well-known/mcp/server-card.json <ExternalLinkIcon />
              </Button>
            </a>
            <a href="/openapi.json" target="_blank" rel="noopener noreferrer">
              <Button size="1" variant="soft">
                /openapi.json <ExternalLinkIcon />
              </Button>
            </a>
            <a href="/robots.txt" target="_blank" rel="noopener noreferrer">
              <Button size="1" variant="soft">
                /robots.txt <ExternalLinkIcon />
              </Button>
            </a>
            <a href="/sitemap.xml" target="_blank" rel="noopener noreferrer">
              <Button size="1" variant="soft">
                /sitemap.xml <ExternalLinkIcon />
              </Button>
            </a>
          </Flex>
        </Box>
      </Flex>
    </Container>
  )
}
