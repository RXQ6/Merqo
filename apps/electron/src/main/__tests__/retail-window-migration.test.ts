import { describe, expect, it } from 'bun:test'
import { migrateRetailWindows, type SavedWindow } from '../window-state'

const saved = (workspaceId: string, query = ''): SavedWindow => ({
  type: 'main', workspaceId, bounds: { x: 0, y: 0, width: 1400, height: 900 },
  url: `file:///app/index.html?workspaceId=${workspaceId}${query}`,
})

describe('former dedicated analysis window migration', () => {
  it('keeps the conversation route when both old windows were saved, regardless of order', () => {
    const agent = saved('a', '&route=allSessions/session/123')
    const retail = saved('a', '&surface=retail')
    expect(migrateRetailWindows([retail, agent])).toEqual([agent])
    expect(migrateRetailWindows([agent, retail])).toEqual([agent])
  })
  it('restores a sole legacy analysis window as an ordinary window with an analysis view', () => {
    const original = saved('a', '&surface=retail')
    const result = migrateRetailWindows([original, original])
    expect(result).toHaveLength(1)
    const url = new URL(result[0]!.url!)
    expect(url.searchParams.get('surface')).toBeNull()
    expect(url.searchParams.get('view')).toBe('retail')
    expect(original.url).toContain('surface=retail')
  })
  it('preserves intentionally opened modern windows and other workspace windows', () => {
    const windows = [saved('a'), saved('a', '&view=retail'), saved('b', '&surface=retail')]
    const migrated = migrateRetailWindows(windows)
    expect(migrated).toHaveLength(3)
    expect(migrated.slice(0, 2)).toEqual(windows.slice(0, 2))
    expect(migrateRetailWindows(migrated)).toEqual(migrated)
  })
})
