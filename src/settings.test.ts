import { describe, expect, it } from '@effect/vitest'
import { matchesRepository } from './bot.ts'
import { pathWithin } from './settings.ts'

describe('repository routing', () => {
  it('rejects clone destinations outside the configured root', () => {
    expect(() => pathWithin('/srv/repos', '../elsewhere')).toThrow()
    expect(() => pathWithin('/srv/repos', '/tmp/elsewhere')).toThrow()
    expect(() => pathWithin('relative', 'repo')).toThrow()
    expect(pathWithin('/srv/repos', 'owner/repo')).toBe('/srv/repos/owner/repo')
  })
  it('uses the repository remote instead of a misleading project title', () => {
    const project = {
      id: 'project',
      title: 'owner/wanted',
      workspaceRoot: '/srv/existing',
      repositoryIdentity: { locator: { remoteUrl: 'git@github.com:owner/other.git' } },
    }
    expect(matchesRepository(project, 'owner/wanted')).toBe(false)
    expect(matchesRepository(project, 'owner/other')).toBe(true)
  })
})
