import bcrypt from 'bcryptjs'
import { createDb } from './index'
import { runMigrations } from './migrate'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 开发环境种子数据（npm run seed）
 * - G3 定稿：admin 独立账号体系（admin 表 + 种子账号）
 * - 场景包目录：industry_work_assistant（行业工作助手）/ generate_image（生成图片），
 *   对应 artifacts/02_design/ 下两个 YAML（display_name_template 含 {industry}，pricing.unit 区分 session/image）
 * - 一个示例租户 + owner/employee 账号 + 2 个场景部署（display_name 按行业渲染）
 *
 * 账号：
 *   owner / owner123   （主账号）
 *   employee / emp123  （员工）
 *   admin / admin123   （运营管理员）
 */

/** 场景包：行业工作助手（对应 artifacts/02_design/医美行业工作助手.yaml） */
const PACKAGE_IWA = {
  id: 'industry_work_assistant',
  name: '行业工作助手',
  display_name_template: '{industry}行业工作助手', // 部署层按租户一级行业渲染（医美→医美行业工作助手）
  version: '1.0.0',
  description: '行业文本对话底座：按租户一级行业加载知识叠加层，多轮对话 + 行业合规 + 会话级积分计费',
  emoji: '🏥',
  color: '#00A0E9',
  pricing: { deduct_points: 10, actual_points: 10, refund_on_failure: false, unit: 'session', included_rounds: 20, extra_round_points: 1, round_limit: 50 },
  runtime: { model: 'deepseek-v4-flash', provider: 'deepseek', skills: ['knowledge_retriever', 'compliance_check'] },
  memory: { bank_id_template: 'informate-tenant-{user}-{profile}', read_only_banks: ['informate-common', 'informate-industry_医美'] },
  knowledge: { types: ['terms', 'faq', 'scripts', 'sop', 'regulations', 'cases', 'templates'], sub_industry: null },
  workflow: { description: '意图解析 → 分层知识检索（P1→P4）→ 租户记忆加载 → 合规检查 → 流式回复', produces: 'text' },
  artifact: { type: 'text', actions: [{ label: '复制', type: 'copy' }, { label: '下载', type: 'download' }] },
  compliance: { enabled: true, rule_packs: ['general', 'medical'], ai_label: true },
}

/** 场景包：生成图片（对应 artifacts/02_design/生成图片.yaml） */
const PACKAGE_GENIMG = {
  id: 'generate_image',
  name: '生成图片',
  display_name_template: '{industry}营销生图', // 医美→医美营销生图（UIUX §2.2 对齐 G14）
  version: '1.0.0',
  description: '营销图/海报/产品图生成（Seedream 5.0 异步任务）：Prompt 扩写 + 前置合规检查 + 产出物面板展示与跨场景传递',
  emoji: '🖼️',
  color: '#FF7F50',
  pricing: { deduct_points: 20, actual_points: 15, refund_on_failure: true, unit: 'image' }, // unit=image 按张计费
  runtime: { model: 'seedream-5.0', provider: 'volcengine', skills: ['seedream_v5_generator', 'compliance_check'] },
  memory: { bank_id_template: 'informate-tenant-{user}-{profile}', read_only_banks: ['informate-common'] },
  knowledge: { types: [], sub_industry: null },
  workflow: { description: '意图解析&品牌视觉提取 → 前置合规检查 → Prompt 扩写 → 异步任务（冻结积分）→ 产出物入面板', produces: 'image' },
  artifact: { type: 'image', actions: [{ label: '预览', type: 'preview' }, { label: '下载高清图', type: 'download' }, { label: '重新生成', type: 'regenerate' }] },
  compliance: { enabled: true, rule_packs: ['general', 'medical'], ai_label: true },
}

/** 部署层行业渲染：{industry} → 租户一级行业 */
function renderDisplayName(template: string, industry: string): string {
  return template.replace(/\{industry\}/g, industry)
}

export function seed(db: ReturnType<typeof createDb>): void {
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c

  if (count('admin') === 0) {
    db.prepare(`INSERT INTO admin (id, username, credentials_hash, name, status) VALUES (?, ?, ?, ?, ?)`)
      .run('a-seed-001', 'admin', bcrypt.hashSync('admin123', 10), '运营管理员', 'active')
    console.log('[seed] admin 种子账号已创建（admin / admin123）')
  }

  // ---------- 场景包目录（seed 预置，POST /scenarios/deploy 校验存在性） ----------
  if (count('scenario_package') === 0) {
    const tx = db.transaction(() => {
      for (const pkg of [PACKAGE_IWA, PACKAGE_GENIMG]) {
        db.prepare(`INSERT INTO scenario_package (id, name, display_name_template, version, description, emoji, color, pricing_unit, deduct_points, schema_payload)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(pkg.id, pkg.name, pkg.display_name_template, pkg.version, pkg.description, pkg.emoji, pkg.color,
               pkg.pricing.unit, pkg.pricing.deduct_points, JSON.stringify(pkg))
      }
    })
    tx()
    console.log('[seed] 场景包目录已创建（industry_work_assistant / generate_image）')
  }

  if (count('tenant') === 0) {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO tenant (id, name, industry, sub_industry, status, plan, balance, trial_sessions_used, trial_session_limit)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('t-seed-001', '示例医美机构', '医美', '植发', 'trial', 'standard', 200, 0, 20)
      db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('u-seed-owner', 't-seed-001', 'owner', 'owner', bcrypt.hashSync('owner123', 10), 'active', null)
      db.prepare(`INSERT INTO user (id, tenant_id, role, name, credentials_hash, status, credit_limit)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('u-seed-emp', 't-seed-001', 'employee', 'employee', bcrypt.hashSync('emp123', 10), 'active', 200)
      // 部署 display_name 按行业渲染（医美 → 医美行业工作助手 / 医美营销生图）
      db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, status)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run('d-seed-001', 't-seed-001', PACKAGE_IWA.id, PACKAGE_IWA.version,
             renderDisplayName(PACKAGE_IWA.display_name_template, '医美'), 'active')
      db.prepare(`INSERT INTO scenario_deployment (id, tenant_id, scenario_id, scenario_version, display_name, status)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run('d-seed-002', 't-seed-001', PACKAGE_GENIMG.id, PACKAGE_GENIMG.version,
             renderDisplayName(PACKAGE_GENIMG.display_name_template, '医美'), 'active')
    })
    tx()
    console.log('[seed] 示例租户 + owner/employee 账号 + 2 个场景部署已创建（display_name 行业渲染）')
  } else {
    // 旧种子兼容：历史部署用的旧 scenario_id 对齐到场景包目录并渲染 display_name
    db.prepare(`UPDATE scenario_deployment SET scenario_id = ?, scenario_version = ?, display_name = ?
                WHERE scenario_id = 'industry-worker' AND tenant_id = 't-seed-001'`)
      .run(PACKAGE_IWA.id, PACKAGE_IWA.version, renderDisplayName(PACKAGE_IWA.display_name_template, '医美'))
    db.prepare(`UPDATE scenario_deployment SET scenario_id = ?, scenario_version = ?, display_name = ?
                WHERE scenario_id = 'image-generation' AND tenant_id = 't-seed-001'`)
      .run(PACKAGE_GENIMG.id, PACKAGE_GENIMG.version, renderDisplayName(PACKAGE_GENIMG.display_name_template, '医美'))
    console.log('[seed] 已有数据，跳过租户种子（旧部署 scenario_id 已对齐场景包目录）')
  }
}

/** CLI 入口：npm run seed */
if (require.main === module) {
  const dbPath = process.env.DB_PATH ?? path.join(__dirname, '..', '..', 'data', 'informate.db')
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = createDb(dbPath)
  try {
    runMigrations(db)
    seed(db)
  } finally {
    db.close()
  }
}
