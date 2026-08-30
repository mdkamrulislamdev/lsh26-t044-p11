/**
 * Upstash Redis, read-through and ALWAYS optional. A cache outage costs
 * latency, never correctness — every function here falls back to the producer
 * if Redis is unreachable, and nothing cached is ever the source of truth for a
 * rule verdict.
 *
 * Plan generation is the only expensive thing in this system and it is pure:
 * the same case always yields the same plan. That is why the solver is
 * deterministic, and why this cache is safe.
 */

import { Redis } from '@upstash/redis'

let redis = null
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
  }
} catch (e) {
  console.error(JSON.stringify({ level: 'warn', msg: 'redis init failed', err: e.message }))
}

export const enabled = () => redis !== null

const stats = { hit: 0, miss: 0, error: 0 }
export const cacheStats = () => ({ ...stats, enabled: enabled() })

export async function cached(key, ttlSeconds, produce) {
  if (!redis) return produce()
  try {
    const hit = await redis.get(key)
    if (hit !== null && hit !== undefined) {
      stats.hit++
      return hit
    }
  } catch (e) {
    stats.error++
    console.error(JSON.stringify({ level: 'warn', msg: 'redis get', key, err: e.message }))
    return produce()
  }
  stats.miss++
  const value = await produce()
  try {
    await redis.set(key, value, { ex: ttlSeconds })
  } catch (e) {
    stats.error++
    console.error(JSON.stringify({ level: 'warn', msg: 'redis set', key, err: e.message }))
  }
  return value
}

export async function drop(prefix) {
  if (!redis) return 0
  try {
    const keys = await redis.keys(`${prefix}*`)
    if (!keys.length) return 0
    await redis.del(...keys)
    return keys.length
  } catch {
    return 0
  }
}

export async function ping() {
  if (!redis) return false
  try {
    await redis.set('healthz', '1', { ex: 30 })
    return (await redis.get('healthz')) === 1 || (await redis.get('healthz')) === '1'
  } catch {
    return false
  }
}

// Keys. Move-validation is keyed on plan version, so any mutation invalidates
// the whole generation without an explicit flush.
export const K = {
  caseDetail: (id) => `case:${id}:v1`,
  plan: (caseId, solverVersion) => `plan:gen:${caseId}:${solverVersion}`,
  move: (planId, version, job, tech) => `mv:${planId}:${version}:${job}:${tech}`,
}
