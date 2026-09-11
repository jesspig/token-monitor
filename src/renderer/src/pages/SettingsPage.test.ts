import { describe, expect, it } from 'vitest'
import { buildSettingsPayload, parseTraeTrajectoryRootsInput } from './SettingsPage'

describe('SettingsPage Trae Agent 设置 payload', () => {
  it('多行输入 trim、去空并按首次出现顺序去重', () => {
    expect(parseTraeTrajectoryRootsInput('  /project/a/trajectories  \n\n/project/b/trajectories\n/project/a/trajectories')).toEqual([
      '/project/a/trajectories',
      '/project/b/trajectories'
    ])
  })

  it('保存 payload 包含规范化后的 Trae 多根目录', () => {
    expect(buildSettingsPayload({
      syncMin: '5',
      statsRefreshSec: '30',
      retentionDays: '90',
      pricingSyncMin: '5',
      dataDir: ' /data/token-monitor ',
      currentDataDir: '/fallback',
      traeTrajectoryRoots: ' /project/a/trajectories \n/project/b/trajectories\n/project/a/trajectories ',
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: null,
      closeToTray: true
    })).toMatchObject({
      syncIntervalMs: 300_000,
      statsRefreshIntervalMs: 30_000,
      retentionDays: 90,
      pricingSyncIntervalMs: 300_000,
      dataDir: '/data/token-monitor',
      traeTrajectoryRoots: ['/project/a/trajectories', '/project/b/trajectories'],
      dailyBudgetUsd: 10,
      monthlyBudgetUsd: null,
      closeToTray: true
    })
  })
})
