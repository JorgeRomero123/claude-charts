import type { ChartKind, ChartSeries, ChartSpec } from '../types'

export type { ChartSpec } from '../types'
type Series = ChartSeries
export type Drawing = { columns: number; rows: number; cells: string }

export const PALETTE = [0x4e9af1, 0xf28e2b, 0x59c17a, 0xe15759, 0xb07aa1, 0x76b7b2]
export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`
export const colorOf = (i: number) => PALETTE[i % PALETTE.length] ?? 0x4e9af1

export const DEFAULT = 0x01000000
export const DIM = 0x808080
const MAX_POINTS = 400
const MAX_SERIES = 6
export const PLOT_ROWS = 11

/** The tool's arguments as a spec, or the reason they are not one. */
export const normalize = (input: Record<string, unknown>): ChartSpec | string => {
  const kind = input.kind ?? 'line'
  if (kind !== 'line' && kind !== 'bars' && kind !== 'hbars')
    return 'kind must be "line", "bars" or "hbars".'
  if (!Array.isArray(input.labels) || input.labels.length === 0)
    return 'labels must be a non-empty array.'
  if (input.labels.length > MAX_POINTS) return `labels holds more than ${MAX_POINTS} points; aggregate first.`
  const labels = input.labels.map(String)
  if (!Array.isArray(input.series) || input.series.length === 0)
    return 'series must be a non-empty array of { name, values }.'
  if (input.series.length > MAX_SERIES) return `series holds more than ${MAX_SERIES}; keep the top ones.`
  const series: Series[] = []
  for (const raw of input.series as unknown[]) {
    const one = (raw ?? {}) as Record<string, unknown>
    if (!Array.isArray(one.values) || one.values.length !== labels.length)
      return `series "${String(one.name ?? '?')}" needs one value per label (${labels.length}).`
    const values = one.values.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null))
    if (values.every(v => v === null)) return `series "${String(one.name ?? '?')}" has no numeric value.`
    series.push({ name: String(one.name ?? `series ${series.length + 1}`), values })
  }
  return {
    title: String(input.title ?? 'Chart'),
    kind,
    labels,
    series,
    unit: typeof input.unit === 'string' ? input.unit : '',
    ...(typeof input.note === 'string' && input.note !== '' ? { note: input.note } : {}),
  }
}

const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '')
export const fmt = (v: number, unit = ''): string => {
  const a = Math.abs(v)
  const s =
    a >= 1e6 ? `${trim(v / 1e6)}M`
    : a >= 1e4 ? `${trim(v / 1e3)}k`
    : Number.isInteger(v) ? String(v)
    : a >= 100 ? v.toFixed(0)
    : trim(v)
  return s + unit
}

export const niceStep = (x: number) => {
  if (!(x > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(x))
  const m = x / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

export type Grid = { columns: number; rows: number; words: Uint32Array }

export const makeGrid = (columns: number, rows: number): Grid => {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) {
    words[i * 3] = 0x20
    words[i * 3 + 1] = DEFAULT
    words[i * 3 + 2] = DEFAULT
  }
  return { columns, rows, words }
}

const put = (g: Grid, x: number, y: number, codePoint: number, color: number) => {
  if (x < 0 || y < 0 || x >= g.columns || y >= g.rows) return
  const i = (y * g.columns + x) * 3
  g.words[i] = codePoint
  g.words[i + 1] = color
}

/** A Raster cell takes one printable width-1 character; anything else is drawn as `?`. */
const safe = (c: number) =>
  (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0x24f && c !== 0xad) || (c >= 0x370 && c <= 0x4ff) || c === 0x2026
    ? c
    : 0x3f

export const write = (g: Grid, x: number, y: number, s: string, color: number) => {
  for (let i = 0; i < s.length; i++) put(g, x + i, y, safe(s.charCodeAt(i)), color)
}

export const clip = (s: string, width: number) =>
  s.length <= width ? s : width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}…`

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export const base64 = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : '='
    out += i + 2 < bytes.length ? B64[c & 63]! : '='
  }
  return out
}

export const pack = (g: Grid): Drawing => {
  const view = new DataView(new ArrayBuffer(g.words.length * 4))
  g.words.forEach((word, i) => view.setUint32(i * 4, word, true))
  return { columns: g.columns, rows: g.rows, cells: base64(new Uint8Array(view.buffer)) }
}

export const numbers = (spec: ChartSpec) =>
  spec.series.flatMap(s => s.values.filter((v): v is number => v !== null))

/** The left gutter with its three tick labels and the two axis lines; answers where the plot starts. */
const axes = (g: Grid, rows: number, lo: number, hi: number, unit: string, isLowOnAxis: boolean) => {
  const ticks = [fmt(hi, unit), fmt((hi + lo) / 2, unit), fmt(lo, unit)]
  const gutter = Math.max(...ticks.map(t => t.length))
  const middle = (rows - 1) / 2
  const at = [0, middle, isLowOnAxis ? rows : rows - 1]
  for (let y = 0; y < rows; y++) put(g, gutter, y, at.includes(y) ? 0x2524 : 0x2502, DIM)
  put(g, gutter, rows, isLowOnAxis ? 0x253c : 0x2514, DIM)
  for (let x = gutter + 1; x < g.columns; x++) put(g, x, rows, 0x2500, DIM)
  ticks.forEach((t, i) => write(g, gutter - t.length, at[i] ?? 0, t, DIM))
  return gutter + 1
}

const line = (spec: ChartSpec, columns: number): Drawing => {
  const all = numbers(spec)
  const min = Math.min(...all)
  const max = Math.max(...all)
  const step = niceStep((max - min || Math.abs(max) || 1) / 8)
  let lo = Math.floor(min / step) * step
  let hi = Math.ceil(max / step) * step
  if (min >= 0 && min <= max - min) lo = 0
  if (hi === lo) hi = lo + step
  const rows = PLOT_ROWS
  const g = makeGrid(columns, rows + 2)
  const x0 = axes(g, rows, lo, hi, spec.unit, false)
  const w = columns - x0
  const dotsW = w * 2
  const dotsH = rows * 4
  const n = spec.labels.length
  const bits = new Uint8Array(w * rows)
  const tint = new Uint32Array(w * rows)
  const xOf = (i: number) => (n === 1 ? Math.floor(dotsW / 2) : Math.round((i * (dotsW - 1)) / (n - 1)))
  const yOf = (v: number) => Math.round(((hi - v) / (hi - lo)) * (dotsH - 1))
  const dot = (x: number, y: number, color: number) => {
    if (x < 0 || y < 0 || x >= dotsW || y >= dotsH) return
    const cell = (y >> 2) * w + (x >> 1)
    const row = y & 3
    bits[cell] = (bits[cell] ?? 0) | (x & 1 ? [0x08, 0x10, 0x20, 0x80][row]! : [0x01, 0x02, 0x04, 0x40][row]!)
    tint[cell] = color
  }
  const segment = (ax: number, ay: number, bx: number, by: number, color: number) => {
    const dx = Math.abs(bx - ax)
    const dy = -Math.abs(by - ay)
    const sx = ax < bx ? 1 : -1
    const sy = ay < by ? 1 : -1
    let err = dx + dy
    let x = ax
    let y = ay
    for (;;) {
      dot(x, y, color)
      if (x === bx && y === by) return
      const twice = 2 * err
      if (twice >= dy) { err += dy; x += sx }
      if (twice <= dx) { err += dx; y += sy }
    }
  }
  // Drawn last to first, so the first series is on top where two cross.
  for (let s = spec.series.length - 1; s >= 0; s--) {
    const color = colorOf(s)
    let before: [number, number] | undefined
    spec.series[s]?.values.forEach((v, i) => {
      if (v === null) { before = undefined; return }
      const here: [number, number] = [xOf(i), yOf(v)]
      if (before) segment(before[0], before[1], here[0], here[1], color)
      else dot(here[0], here[1], color)
      before = here
    })
  }
  for (let i = 0; i < bits.length; i++)
    if (bits[i]) put(g, x0 + (i % w), Math.floor(i / w), 0x2800 + (bits[i] ?? 0), tint[i] ?? DEFAULT)

  const widest = Math.max(...spec.labels.map(l => l.length))
  const count = Math.min(n, Math.max(2, Math.floor(w / (widest + 2))))
  const picks = n === 1 ? [0] : Array.from({ length: count }, (_, j) => Math.round((j * (n - 1)) / (count - 1)))
  const placed: [number, number][] = []
  for (const i of [picks[picks.length - 1] ?? 0, ...picks.slice(0, -1)]) {
    const label = clip(spec.labels[i] ?? '', w)
    const centre = x0 + (xOf(i) >> 1)
    const start = Math.min(columns - label.length, Math.max(x0, centre - (label.length >> 1)))
    const end = start + label.length
    if (placed.some(([a, b]) => start <= b && end >= a)) continue
    placed.push([start, end])
    write(g, start, rows + 1, label, DIM)
  }
  return pack(g)
}

const bars = (spec: ChartSpec, columns: number): Drawing => {
  const max = Math.max(0, ...numbers(spec))
  const step = niceStep((max || 1) / 4)
  const hi = Math.ceil((max || 1) / step) * step
  const rows = PLOT_ROWS
  const g = makeGrid(columns, rows + 2)
  const x0 = axes(g, rows, 0, hi, spec.unit, true)
  const w = columns - x0
  const n = spec.labels.length
  const m = spec.series.length
  const slot = Math.floor(w / n)
  const width = Math.min(6, Math.max(1, Math.floor((slot - 1) / m)))
  const inset = Math.max(0, Math.floor((slot - width * m) / 2))
  spec.series.forEach((s, j) => {
    s.values.forEach((v, i) => {
      if (v === null || v <= 0) return
      const eighths = Math.max(1, Math.round((v / hi) * rows * 8))
      for (let k = 0; k < width; k++) {
        const x = x0 + i * slot + inset + j * width + k
        for (let r = 0; r * 8 < eighths; r++) {
          const part = Math.min(8, eighths - r * 8)
          put(g, x, rows - 1 - r, 0x2580 + part, colorOf(j))
        }
      }
    })
  })
  const widest = Math.max(...spec.labels.map(l => l.length))
  const every = slot > widest ? 1 : Math.ceil((widest + 1) / slot)
  for (let i = 0; i < n; i += every) {
    const room = every === 1 ? Math.max(1, slot - 1) : widest
    const label = clip(spec.labels[i] ?? '', room)
    const centre = x0 + i * slot + (slot >> 1)
    write(g, Math.min(columns - label.length, Math.max(x0, centre - (label.length >> 1))), rows + 1, label, DIM)
  }
  return pack(g)
}

const hbars = (spec: ChartSpec, columns: number): Drawing => {
  const m = spec.series.length
  const per = m > 1 ? m + 1 : 1
  const n = Math.min(spec.labels.length, Math.floor(60 / per))
  const max = Math.max(0, ...numbers(spec)) || 1
  const gutter = Math.min(Math.max(...spec.labels.slice(0, n).map(l => l.length)), Math.floor(columns * 0.35))
  const texts = spec.series.map(s => s.values.map(v => (v === null ? '' : fmt(v, spec.unit))))
  const widest = Math.max(...texts.flat().map(t => t.length))
  const room = Math.max(4, columns - gutter - 1 - widest - 1)
  const g = makeGrid(columns, n * per - (m > 1 ? 1 : 0))
  for (let i = 0; i < n; i++) {
    write(g, 0, i * per, clip(spec.labels[i] ?? '', gutter).padStart(gutter), DEFAULT)
    spec.series.forEach((s, j) => {
      const v = s.values[i]
      if (v === null || v === undefined) return
      const y = i * per + j
      const eighths = v <= 0 ? 0 : Math.max(1, Math.round((v / max) * room * 8))
      let x = gutter + 1
      for (let left = eighths; left > 0; left -= 8) put(g, x++, y, left >= 8 ? 0x2588 : 0x2590 - left, colorOf(j))
      write(g, x + 1, y, texts[j]?.[i] ?? '', DIM)
    })
  }
  return pack(g)
}

/** Whether the vertical bars of a spec fit a plot `columns` wide; a spec that does not is drawn as lines. */
const isBarsFitting = (spec: ChartSpec, columns: number) =>
  Math.floor((columns - 10) / spec.labels.length) >= spec.series.length

export const draw = (spec: ChartSpec, available: number): Drawing => {
  const columns = Math.min(110, Math.max(36, Math.floor(available)))
  if (spec.kind === 'hbars') return hbars(spec, columns)
  if (spec.kind === 'bars' && isBarsFitting(spec, columns)) return bars(spec, columns)
  return line(spec, columns)
}
