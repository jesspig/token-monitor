import { describe, it, expect } from 'vitest'
import { createDatabase, migrate, type SqliteDatabase } from './db'

function columnsOf(db: SqliteDatabase, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

describe('v6 迁移：sync_cursors.byte_offset', () => {
  it('全新库迁移至 v6，sync_cursors 含 byte_offset 列，重复迁移幂等', () => {
    const db = createDatabase(':memory:')
    try {
      migrate(db)
      migrate(db)
      expect(db.pragma('user_version', { simple: true })).toBe(6)
      expect(columnsOf(db, 'sync_cursors')).toContain('byte_offset')
    } finally {
      db.close()
    }
  })

  it('v5 存量库升级：ALTER 增列后存量行 byte_offset 为 NULL（未知语义）', () => {
    const db = createDatabase(':memory:')
    try {
      db.exec(`
        CREATE TABLE sync_cursors (
          file_path   TEXT    NOT NULL PRIMARY KEY,
          data_source TEXT    NOT NULL DEFAULT '',
          line_offset INTEGER NOT NULL DEFAULT 0,
          file_mtime  INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        )
      `)
      db.prepare(
        `INSERT INTO sync_cursors (file_path, data_source, line_offset, file_mtime, updated_at)
         VALUES ('/legacy/session.jsonl.zstd', 'dsh', 7, 42, 1)`
      ).run()
      db.pragma('user_version = 5')

      migrate(db)

      expect(db.pragma('user_version', { simple: true })).toBe(6)
      const row = db.prepare('SELECT * FROM sync_cursors').get() as {
        file_path: string
        line_offset: number
        byte_offset: number | null
      }
      expect(row).toMatchObject({ file_path: '/legacy/session.jsonl.zstd', line_offset: 7 })
      expect(row.byte_offset).toBeNull()
    } finally {
      db.close()
    }
  })
})
