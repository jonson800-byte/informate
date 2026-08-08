/**
 * 部署层行业渲染（FR-103 / 场景包 Schema V1 display_name_template）
 * 例：租户一级行业=医美，模板="{industry}行业工作助手" → "医美行业工作助手"；
 *     模板="{industry}营销生图" → "医美营销生图"（对齐 UIUX §2.2 / G14）
 */
export function renderDisplayName(template: string, industry: string): string {
  return template.replace(/\{industry\}/g, industry)
}
