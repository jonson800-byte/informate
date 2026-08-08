import fs from 'node:fs'
import path from 'node:path'
import { buildApp } from './app'
import { config } from './config'

// 确保数据目录存在
if (config.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
}

const app = buildApp()

// 积分冻结兜底扫描（Codex G1：任务级按 ref 状态释放）——每分钟扫一次，不阻塞进程退出
import { createCreditService } from './services/credit'
const credit = createCreditService(app.db)
const scanTimer = setInterval(() => {
  try {
    const r = credit.scanExpiredFreezes()
    if (r.released > 0 || r.settled > 0) {
      console.log(`[credit-scan] 释放 ${r.released} / 结算 ${r.settled} / 跳过 ${r.skipped}`)
    }
  } catch (err) {
    console.error('[credit-scan] 扫描失败:', (err as Error).message)
  }
}, 60_000)
scanTimer.unref()

app.listen({ port: config.port, host: '0.0.0.0' })
  .then((addr) => {
    console.log(`[informate-backend] listening on ${addr} (db=${config.dbPath})`)
  })
  .catch((err) => {
    console.error('[informate-backend] 启动失败', err)
    process.exit(1)
  })

// 优雅退出
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close()
    process.exit(0)
  })
}
