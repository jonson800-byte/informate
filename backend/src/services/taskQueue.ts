import { EventEmitter } from 'node:events'

/**
 * 异步任务队列（T7 生图执行器）
 *
 * 依据：技术方案 §2.4（冻结 15 → BullMQ 任务 → Seedream 5.0 → 回调结算/失败退分）、
 *       R4 备注（MVP 可单机简化：Redis 不可用时降级内存队列）。
 *
 * 驱动选择（按优先级）：
 * 1. Redis + BullMQ：设置 REDIS_URL（或传入 redisUrl）且已安装 bullmq → 用 BullMQ（生产形态）；
 * 2. 内存 FIFO + 异步 worker：默认/兜底（无 Redis 依赖，测试与单机 MVP 用）。
 *
 * 统一接口：
 * - enqueue(task)：入队（同 id 去重——同一生图任务不重复入队，配合 execute 幂等）；
 * - on('completed'|'failed')：任务终结事件（测试可等待）；
 * - drain()：等待队列排空（含在途任务）；close()：停止接收并排空。
 *
 * worker 语义：串行不保证、并发 concurrency（默认 2）；任务处理器抛错 → failed 事件。
 */

/** 队列任务载荷（id 即生图任务 ID = artifact.id） */
export interface QueueTask<P = unknown> {
  id: string
  type: string
  payload?: P
  enqueuedAt?: number
}

export interface TaskQueueEvents {
  /** 任务处理成功（result 为处理器返回值） */
  completed: (taskId: string, result: unknown) => void
  /** 任务处理失败（error 为处理器抛出的错误） */
  failed: (taskId: string, error: Error) => void
}

export interface TaskQueue {
  /** 入队（同 id 已排队/执行中 → 静默去重，返回 false） */
  enqueue(task: QueueTask): boolean
  /** 队列中待处理数量 */
  readonly pending: number
  /** 正在执行数量 */
  readonly running: number
  on<K extends keyof TaskQueueEvents>(event: K, cb: TaskQueueEvents[K]): void
  /** 等待队列排空（含在途任务完成） */
  drain(): Promise<void>
  /** 关闭队列：不再接收新任务，排空在途任务后返回 */
  close(): Promise<void>
}

export interface TaskQueueOptions {
  /** 任务处理器（worker 执行体，抛错视为任务失败） */
  processor: (task: QueueTask) => Promise<unknown>
  /** 并发度（默认 2） */
  concurrency?: number
  /** Redis 连接串（显式指定；缺省读 REDIS_URL 环境变量） */
  redisUrl?: string
}

/** 模块是否可加载（bullmq 未安装时回落内存队列） */
function canRequire(mod: string): boolean {
  try {
    require.resolve(mod)
    return true
  } catch {
    return false
  }
}

/**
 * 内存 FIFO 队列 + 异步 worker（默认路径）
 * - 单进程内消费；进程退出即丢队列（MVP 可接受，正式环境用 BullMQ 持久化）
 * - 同 id 去重：队列中或执行中已存在 → 入队被忽略（execute 重复调用安全）
 */
function createMemoryQueue(opts: TaskQueueOptions): TaskQueue {
  const concurrency = opts.concurrency ?? 2
  const queue: QueueTask[] = []
  const runningIds = new Set<string>()
  let running = 0
  let closed = false
  const emitter = new EventEmitter()
  let drainWaiters: Array<() => void> = []

  function maybeResolveDrain(): void {
    if (queue.length === 0 && running === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters
      drainWaiters = []
      for (const w of waiters) w()
    }
  }

  /** worker 泵：按并发度从 FIFO 取任务执行 */
  function pump(): void {
    // H4 修复（Codex 批次 C）：closed 只拒绝新 enqueue，剩余任务仍须消费完——
    // 否则 close() 置 closed 后 pump 见 closed 停止消费，drain waiter 永不 resolve（死锁）
    if (closed && queue.length === 0 && running === 0) return
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift() as QueueTask
      running++
      runningIds.add(task.id)
      opts.processor(task)
        .then((result) => emitter.emit('completed', task.id, result))
        .catch((err: Error) => emitter.emit('failed', task.id, err instanceof Error ? err : new Error(String(err))))
        .finally(() => {
          running--
          runningIds.delete(task.id)
          maybeResolveDrain()
          pump()
        })
    }
  }

  return {
    enqueue(task) {
      if (closed) throw new Error('任务队列已关闭')
      if (queue.some((t) => t.id === task.id) || runningIds.has(task.id)) return false
      task.enqueuedAt = Date.now()
      queue.push(task)
      pump()
      return true
    },
    get pending() { return queue.length },
    get running() { return running },
    on(event, cb) { emitter.on(event, cb) },
    async drain() {
      if (queue.length === 0 && running === 0) return
      await new Promise<void>((resolve) => drainWaiters.push(resolve))
    },
    async close() {
      closed = true
      await this.drain()
    },
  }
}

/**
 * Redis + BullMQ 队列（生产形态，惰性加载 bullmq）
 * - 需要 `npm i bullmq`（及 ioredis 依赖）并配置 REDIS_URL
 * - 用 jobId = task.id 天然去重（同 id 重复 add 被 BullMQ 忽略）
 */
function createBullmqQueue(opts: TaskQueueOptions): TaskQueue {
  if (!canRequire('bullmq')) {
    throw new Error('使用 BullMQ 需先安装：npm i bullmq（并确保 Redis 可用，见技术方案 §2.4/R4）')
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Queue, Worker } = require('bullmq') as {
    Queue: new (name: string, cfg: { connection: { url: string } }) => {
      add(name: string, data: unknown, cfg: { jobId: string; removeOnComplete: number }): Promise<unknown>
      close(): Promise<void>
    }
    Worker: new (name: string, fn: (job: { id: string; data: QueueTask }) => Promise<unknown>, cfg: {
      connection: { url: string }; concurrency: number
    }) => {
      on(event: 'completed' | 'failed', cb: (job: { id: string; returnvalue?: unknown }, err?: Error) => void): void
      close(): Promise<void>
    }
  }
  const connection = { url: opts.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379' }
  const queueName = 'informate-image-tasks'
  const queue = new Queue(queueName, { connection })
  const worker = new Worker(queueName, async (job) => opts.processor(job.data), {
    connection,
    concurrency: opts.concurrency ?? 2,
  })
  const emitter = new EventEmitter()
  worker.on('completed', (job) => emitter.emit('completed', job.id, job.returnvalue))
  worker.on('failed', (job, err) => emitter.emit('failed', job?.id ?? 'unknown', err ?? new Error('BullMQ 任务失败')))

  return {
    enqueue(task) {
      // jobId = task.id → BullMQ 对同 id 任务去重（幂等入队）
      void queue.add(task.id, task, { jobId: task.id, removeOnComplete: 100 }).catch((err: Error) => {
        emitter.emit('failed', task.id, err)
      })
      return true
    },
    get pending() { return 0 }, // BullMQ 队列长度需异步查询，接口保持同步（记录型返回 0）
    get running() { return 0 },
    on(event, cb) { emitter.on(event, cb) },
    async drain() { /* BullMQ 任务由 Redis 持久化，进程重启可恢复，无需等待 */ },
    async close() {
      await Promise.allSettled([worker.close(), queue.close()])
    },
  }
}

/**
 * 创建任务队列：优先 Redis+BullMQ（REDIS_URL 且可加载 bullmq），否则内存 FIFO。
 * 用法（imagegen 路由内）：
 *   const queue = createTaskQueue({ processor: runImageGenTask })
 */
export function createTaskQueue(opts: TaskQueueOptions): TaskQueue {
  const wantRedis = !!opts.redisUrl || !!process.env.REDIS_URL
  if (wantRedis) {
    if (canRequire('bullmq')) {
      console.info('[taskQueue] 使用 Redis + BullMQ 队列（REDIS_URL 已配置）')
      return createBullmqQueue(opts)
    }
    console.warn('[taskQueue] REDIS_URL 已设置但未安装 bullmq，回落内存 FIFO 队列（MVP 单机形态，技术方案 R4）')
  }
  return createMemoryQueue(opts)
}
