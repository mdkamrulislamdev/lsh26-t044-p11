/**
 * Request-body validation. Runs before anything reaches the domain, so a
 * handler never sees a shape it did not ask for, and a caller always gets a 400
 * naming the field rather than a confusing 404 from further downstream.
 */

import { parseHHMM, ValidationError } from './domain.js'

const bad = (field, why) => {
  throw new ValidationError('INVALID_FIELD', `${field} ${why}`, { field })
}

export function body(req) {
  const b = req.body
  if (b === null || typeof b !== 'object' || Array.isArray(b))
    throw new ValidationError('INVALID_BODY', 'Request body must be a JSON object.')
  return b
}

export function id(b, field, { required = true } = {}) {
  const v = b[field]
  if (v === undefined || v === null || v === '') {
    if (required) bad(field, 'is required.')
    return undefined
  }
  if (typeof v !== 'string') bad(field, 'must be a string.')
  const t = v.trim()
  if (!t) bad(field, 'cannot be blank.')
  if (t.length > 64) bad(field, 'is too long (max 64 characters).')
  if (!/^[A-Za-z0-9._:-]+$/.test(t)) bad(field, 'may only contain letters, digits, . _ : and -')
  return t
}

export function integer(b, field, { min = -Infinity, max = Infinity, required = true, fallback } = {}) {
  const v = b[field]
  if (v === undefined || v === null) {
    if (required) bad(field, 'is required.')
    return fallback
  }
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) bad(field, 'must be a whole number.')
  if (n < min) bad(field, `must be at least ${min}.`)
  if (n > max) bad(field, `must be at most ${max}.`)
  return n
}

export function time(b, field, { required = true, fallback } = {}) {
  const v = b[field]
  if (v === undefined || v === null || v === '') {
    if (required) bad(field, 'is required.')
    return fallback
  }
  return parseHHMM(String(v), field)
}

/** An emergency job, fully validated. Structural feasibility is the engine's job. */
export function emergencyJob(b) {
  const job = {
    id: id(b, 'id', { required: false }) ?? `E${Date.now().toString().slice(-6)}`,
    area: id(b, 'area'),
    skill: String(b.skill ?? '').trim().toLowerCase(),
    duration_minutes: integer(b, 'duration_minutes', { min: 1, max: 24 * 60 }),
    window_start: time(b, 'window_start'),
    window_end: time(b, 'window_end'),
  }
  if (!job.skill) bad('skill', 'is required.')
  return job
}
