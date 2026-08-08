import { randomUUID } from 'node:crypto'

/**
 * 生成带前缀的唯一 ID（如 t-xxx / u-xxx / d-xxx）
 * 说明：SQLite 主键统一 TEXT，运行时创建记录用 UUID 避免碰撞（种子数据用固定可读 ID）
 */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}
