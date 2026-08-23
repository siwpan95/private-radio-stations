// @relay/core — cordis.yml 配置校验器（schema 声明式，错误带字段路径）

export function validateConfig(value, schema, schemaPath) {
  if (value === undefined || value === null) return
  const path = schemaPath || 'config'
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('cordis.yml 配置错误：' + path + ' 应为对象（plugins.config.' + path.slice('config.'.length) + '）')
    }
    for (const [key, sub] of Object.entries(schema.fields || {})) {
      validateConfig(value[key], sub, path + '.' + key)
    }
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      throw new Error('cordis.yml 配置错误：' + path + ' 应为数组')
    }
    if (schema.of === 'number' && value.some((v) => typeof v !== 'number' && !Number.isFinite(Number(v)))) {
      throw new Error('cordis.yml 配置错误：' + path + ' 应为数字数组')
    }
    if (schema.min && value.length < schema.min) {
      throw new Error('cordis.yml 配置错误：' + path + ' 至少需要 ' + schema.min + ' 项')
    }
    return
  }
  const ok =
    schema.type === 'string' ? typeof value === 'string'
      : schema.type === 'boolean' ? typeof value === 'boolean'
        : schema.type === 'number' ? (typeof value === 'number' || Number.isFinite(Number(value)))
          : true
  if (!ok) {
    throw new Error('cordis.yml 配置错误：' + path + ' 应为 ' + schema.type)
  }
  if (schema.type === 'number') {
    const n = Number(value)
    if (schema.min !== undefined && n < schema.min) {
      throw new Error('cordis.yml 配置错误：' + path + ' 不能小于 ' + schema.min)
    }
    if (schema.max !== undefined && n > schema.max) {
      throw new Error('cordis.yml 配置错误：' + path + ' 不能大于 ' + schema.max)
    }
  }
}
