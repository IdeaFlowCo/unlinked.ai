'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Container,
  Flex,
  Box,
  Button,
  Heading,
  TextField,
  Text,
  Card,
  Badge,
  IconButton,
} from '@radix-ui/themes'
import { Cross2Icon, CopyIcon } from '@radix-ui/react-icons'
import Link from 'next/link'

interface AgentKey {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

function formatDate(value: string | null): string {
  if (!value) return 'never'
  return new Date(value).toLocaleString()
}

export default function AgentKeysManager() {
  const [keys, setKeys] = useState<AgentKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [notEnabled, setNotEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [mintedKey, setMintedKey] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/agent-keys')
      if (res.status === 503) {
        setNotEnabled(true)
        setKeys([])
        return
      }
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      const data = await res.json()
      setKeys(data.keys ?? [])
    } catch (err) {
      console.error('failed to load agent keys:', err)
      setError('could not load your keys. try refreshing.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const createKey = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setIsCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/agent-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `request failed (${res.status})`)
      }
      const data = await res.json()
      setMintedKey(data.key)
      setName('')
      await load()
    } catch (err) {
      console.error('failed to create agent key:', err)
      setError(err instanceof Error ? err.message : 'could not create key')
    } finally {
      setIsCreating(false)
    }
  }

  const revokeKey = async (id: string) => {
    setRevokingId(id)
    setError(null)
    try {
      const res = await fetch(`/api/agent-keys/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      await load()
    } catch (err) {
      console.error('failed to revoke agent key:', err)
      setError('could not revoke that key. try again.')
    } finally {
      setRevokingId(null)
    }
  }

  const activeKeys = keys.filter((k) => !k.revoked_at)
  const revokedKeys = keys.filter((k) => k.revoked_at)

  return (
    <Container size="2" pt="4" pb="6">
      <Flex direction="column" gap="4">
        <Box>
          <Heading size="6">agent keys</Heading>
          <Text as="p" size="2" color="gray" mt="1">
            keys let an ai agent (mcp client, script, etc) act as you through the
            unlinked.ai api. each key can only see your own profile and your direct
            connections -- never anyone else&apos;s network.
          </Text>
        </Box>

        {error && (
          <Card size="2" style={{ borderColor: 'var(--red-6)' }}>
            <Text size="2" color="red">
              {error}
            </Text>
          </Card>
        )}

        {notEnabled ? (
          <Card size="3">
            <Text size="2" color="gray">
              agent keys aren&apos;t enabled on this deployment yet.
            </Text>
          </Card>
        ) : (
          <>
            {mintedKey && (
              <Card size="3" style={{ borderColor: 'var(--accent-7)' }}>
                <Flex direction="column" gap="2">
                  <Text size="2" weight="medium">
                    your new key -- copy it now, it won&apos;t be shown again
                  </Text>
                  <Flex align="center" gap="2">
                    <code
                      style={{
                        flex: 1,
                        padding: '8px 10px',
                        background: 'var(--gray-3)',
                        borderRadius: 6,
                        fontSize: 13,
                        wordBreak: 'break-all',
                      }}
                    >
                      {mintedKey}
                    </code>
                    <IconButton
                      variant="soft"
                      onClick={() => navigator.clipboard.writeText(mintedKey)}
                      aria-label="copy key"
                    >
                      <CopyIcon />
                    </IconButton>
                  </Flex>
                  <Button
                    size="1"
                    variant="ghost"
                    onClick={() => setMintedKey(null)}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    dismiss
                  </Button>
                </Flex>
              </Card>
            )}

            <Card size="3">
              <Flex gap="2" align="end" wrap="wrap">
                <Box style={{ flex: 1, minWidth: 200 }}>
                  <Text as="label" size="1" color="gray" mb="1" style={{ display: 'block' }}>
                    key name
                  </Text>
                  <TextField.Root
                    size="2"
                    placeholder="e.g. claude desktop"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createKey()
                    }}
                    disabled={isCreating}
                  />
                </Box>
                <Button onClick={createKey} disabled={isCreating || !name.trim()}>
                  {isCreating ? 'creating...' : 'create key'}
                </Button>
              </Flex>
            </Card>

            <Box>
              <Text size="2" weight="medium" color="gray">
                active keys
              </Text>
              <Flex direction="column" gap="2" mt="2">
                {isLoading ? (
                  <Text size="2" color="gray">
                    loading...
                  </Text>
                ) : activeKeys.length === 0 ? (
                  <Text size="2" color="gray">
                    no active keys yet
                  </Text>
                ) : (
                  activeKeys.map((key) => (
                    <Card key={key.id} size="2">
                      <Flex justify="between" align="center">
                        <Box>
                          <Text size="2" weight="medium">
                            {key.name}
                          </Text>
                          <Text as="div" size="1" color="gray">
                            created {formatDate(key.created_at)} · last used{' '}
                            {formatDate(key.last_used_at)}
                          </Text>
                        </Box>
                        <IconButton
                          variant="soft"
                          color="red"
                          aria-label="revoke key"
                          disabled={revokingId === key.id}
                          onClick={() => revokeKey(key.id)}
                        >
                          <Cross2Icon />
                        </IconButton>
                      </Flex>
                    </Card>
                  ))
                )}
              </Flex>
            </Box>

            {revokedKeys.length > 0 && (
              <Box>
                <Text size="2" weight="medium" color="gray">
                  revoked
                </Text>
                <Flex direction="column" gap="2" mt="2">
                  {revokedKeys.map((key) => (
                    <Card key={key.id} size="2" style={{ opacity: 0.6 }}>
                      <Flex justify="between" align="center">
                        <Text size="2">{key.name}</Text>
                        <Badge color="gray" variant="soft">
                          revoked {formatDate(key.revoked_at)}
                        </Badge>
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              </Box>
            )}
          </>
        )}

        <Link href="/profiles">
          <Text size="2" color="gray">
            ← back to profiles
          </Text>
        </Link>
      </Flex>
    </Container>
  )
}
