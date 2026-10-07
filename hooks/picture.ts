import { DEFAULT, DIM, PLOT_ROWS, base64, clip, colorOf, fmt, makeGrid, niceStep, numbers, pack, write } from './chart'
import type { ChartSpec, Drawing } from './chart'

/**
 * A chart as pixels: the plot is one RGBA picture over a box of cells, and the
 * words around it (tick labels, category names, values) stay terminal text,
 * packed as Rasters so they line up with the picture row for row.
 */
export type Picture = {
  /** The cells left of the plot: tick labels, or category names and values. */
  side: Drawing
  plot: { rgba: string; width: number; height: number; columns: number; rows: number }
  /** The row of x labels under the plot, already indented past `side`; absent for hbars. */
  under?: Drawing
}

const AXIS = 0x8a8a8a
/**
 * One tree may hold 2 MiB of Image source in all, so the charts of a tree share
 * a budget of pixel bytes; a cell is drawn at the largest of these sizes that fits its share.
 */
const CELL_SIZES: [number, number][] = [[14, 28], [12, 24], [10, 20], [8, 16], [6, 12], [4, 8]]
export const TREE_BUDGET = 1_450_000

type Canvas = { width: number; height: number; pixels: Uint8Array; cellW: number; cellH: number }

const canvas = (columns: number, rows: number, budget: number): Canvas => {
  const [cellW, cellH] = CELL_SIZES.find(([w, h]) => columns * w * rows * h * 4 <= budget) ?? [4, 8]
  const width = Math.min(2048, columns * cellW)
  const height = Math.min(2048, rows * cellH)

  return { width, height, pixels: new Uint8Array(width * height * 4), cellW, cellH }
}

/** Source over destination, straight alpha, for one pixel. */
const blend = (c: Canvas, x: number, y: number, color: number, alpha: number) => {
  if (alpha <= 0 || x < 0 || y < 0 || x >= c.width || y >= c.height) return
  const i = (y * c.width + x) * 4
  const a = Math.min(1, alpha)
  const under = (c.pixels[i + 3] ?? 0) / 255
  const out = a + under * (1 - a)
  const mix = (top: number, bottom: number) => Math.round((top * a + bottom * under * (1 - a)) / out)
  c.pixels[i] = mix((color >> 16) & 255, c.pixels[i] ?? 0)
  c.pixels[i + 1] = mix((color >> 8) & 255, c.pixels[i + 1] ?? 0)
  c.pixels[i + 2] = mix(color & 255, c.pixels[i + 2] ?? 0)
  c.pixels[i + 3] = Math.round(out * 255)
}

/** A rectangle with fractional edges: the partly covered rows and columns take partial alpha. */
const rect = (c: Canvas, x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1) => {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const coverY = Math.min(y + 1, y1) - Math.max(y, y0)
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const coverX = Math.min(x + 1, x1) - Math.max(x, x0)
      blend(c, x, y, color, alpha * coverX * coverY)
    }
  }
}

/** Grows a coverage mask by a round-capped stroke from a to b, `radius` pixels either side. */
const stroke = (mask: Float32Array, c: Canvas, ax: number, ay: number, bx: number, by: number, radius: number) => {
  const reach = radius + 1
  const dx = bx - ax
  const dy = by - ay
  const length2 = dx * dx + dy * dy
  for (let y = Math.max(0, Math.floor(Math.min(ay, by) - reach)); y <= Math.min(c.height - 1, Math.ceil(Math.max(ay, by) + reach)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - reach)); x <= Math.min(c.width - 1, Math.ceil(Math.max(ax, bx) + reach)); x++) {
      const px = x + 0.5 - ax
      const py = y + 0.5 - ay
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / length2))
      const cover = radius + 0.5 - Math.hypot(px - t * dx, py - t * dy)
      const i = y * c.width + x
      if (cover > (mask[i] ?? 0)) mask[i] = Math.min(1, cover)
    }
  }
}

const paint = (c: Canvas, mask: Float32Array, color: number) => {
  for (let i = 0; i < mask.length; i++) {
    const cover = mask[i] ?? 0
    if (cover > 0) blend(c, i % c.width, Math.floor(i / c.width), color, cover)
  }
}

const finish = (c: Canvas, columns: number, rows: number): Picture['plot'] => {
  const native = (c.pixels as { toBase64?: () => string }).toBase64

  return {
    rgba: typeof native === 'function' ? native.call(c.pixels) : base64(c.pixels),
    width: c.width,
    height: c.height,
    columns,
    rows,
  }
}

/** The tick labels of a plot `rows` tall, each centred on the row its gridline crosses. */
const ticksOf = (rows: number, lo: number, hi: number, unit: string) => {
  const texts = [fmt(hi, unit), fmt((hi + lo) / 2, unit), fmt(lo, unit)]
  const width = Math.max(...texts.map(t => t.length)) + 1
  const g = makeGrid(width, rows)
  ;[0, (rows - 1) / 2, rows - 1].forEach((y, i) => write(g, width - 1 - (texts[i]?.length ?? 0), y, texts[i] ?? '', DIM))

  return pack(g)
}

/** The three gridlines the tick labels name, the bottom one drawn as the axis. */
const gridlines = (c: Canvas) => {
  const thick = Math.max(1, c.cellW / 8)
  const top = c.cellH / 2
  const bottom = c.height - c.cellH / 2
  rect(c, 0, top - thick / 2, c.width, top + thick / 2, AXIS, 0.22)
  rect(c, 0, (top + bottom - thick) / 2, c.width, (top + bottom + thick) / 2, AXIS, 0.22)
  rect(c, 0, bottom - thick / 2, c.width, bottom + thick / 2, AXIS, 0.75)
}

/** One row of x labels: `at` gives each label's centre cell; a label that would touch a placed one is left out. */
const under = (indent: number, columns: number, labels: string[], picks: number[], at: (i: number) => number) => {
  const g = makeGrid(indent + columns, 1)
  const placed: [number, number][] = []
  for (const i of picks) {
    const label = clip(labels[i] ?? '', columns)
    const start = Math.min(columns - label.length, Math.max(0, Math.round(at(i) - label.length / 2)))
    const end = start + label.length
    if (placed.some(([a, b]) => start <= b && end >= a)) continue
    placed.push([start, end])
    write(g, indent + start, 0, label, DIM)
  }

  return pack(g)
}

const line = (spec: ChartSpec, available: number, budget: number): Picture => {
  const all = numbers(spec)
  const min = Math.min(...all)
  const max = Math.max(...all)
  const step = niceStep((max - min || Math.abs(max) || 1) / 8)
  let lo = Math.floor(min / step) * step
  let hi = Math.ceil(max / step) * step
  if (min >= 0 && min <= max - min) lo = 0
  if (hi === lo) hi = lo + step
  const rows = PLOT_ROWS
  const side = ticksOf(rows, lo, hi, spec.unit)
  const columns = Math.min(255, available - side.columns)
  const c = canvas(columns, rows, budget)
  gridlines(c)
  const n = spec.labels.length
  const top = c.cellH / 2
  const bottom = c.height - c.cellH / 2
  const xOf = (i: number) => (n === 1 ? c.width / 2 : c.cellW + (i * (c.width - 2 * c.cellW)) / (n - 1))
  const yOf = (v: number) => top + ((hi - v) / (hi - lo)) * (bottom - top)
  const radius = c.cellW / 7
  // Drawn last to first, so the first series is on top where two cross.
  for (let s = spec.series.length - 1; s >= 0; s--) {
    const values = spec.series[s]?.values ?? []
    const color = colorOf(s)
    const mask = new Float32Array(c.width * c.height)
    let before: [number, number] | undefined
    values.forEach((v, i) => {
      if (v === null) { before = undefined; return }
      const here: [number, number] = [xOf(i), yOf(v)]
      if (before) {
        if (spec.series.length === 1) {
          // The area under a lone series, fading toward the axis.
          for (let x = Math.ceil(before[0]); x < here[0]; x++) {
            const y = before[1] + ((x - before[0]) / (here[0] - before[0])) * (here[1] - before[1])
            for (let row = Math.ceil(y); row < bottom; row++) blend(c, x, row, color, 0.28 * (1 - (row - y) / (bottom - y + 1)) + 0.04)
          }
        }
        stroke(mask, c, before[0], before[1], here[0], here[1], radius)
      }
      if (n <= 40 || !before) stroke(mask, c, here[0], here[1], here[0], here[1], radius * (n <= 40 ? 2.1 : 1))
      before = here
    })
    paint(c, mask, color)
  }
  const widest = Math.max(...spec.labels.map(l => l.length))
  const count = Math.min(n, Math.max(2, Math.floor(columns / (widest + 2))))
  const picks = n === 1 ? [0] : Array.from({ length: count }, (_, j) => Math.round((j * (n - 1)) / (count - 1)))

  return {
    side,
    plot: finish(c, columns, rows),
    under: under(side.columns, columns, spec.labels, [picks[picks.length - 1] ?? 0, ...picks.slice(0, -1)], i => xOf(i) / c.cellW),
  }
}

const bars = (spec: ChartSpec, available: number, budget: number): Picture => {
  const max = Math.max(0, ...numbers(spec))
  const step = niceStep((max || 1) / 4)
  const hi = Math.ceil((max || 1) / step) * step
  const rows = PLOT_ROWS
  const side = ticksOf(rows, 0, hi, spec.unit)
  const columns = Math.min(255, available - side.columns)
  const c = canvas(columns, rows, budget)
  gridlines(c)
  const n = spec.labels.length
  const m = spec.series.length
  const top = c.cellH / 2
  const bottom = c.height - c.cellH / 2
  const slot = c.width / n
  const group = Math.min(slot * 0.74, m * 7 * c.cellW)
  const gap = m > 1 ? Math.min(2, group / m / 6) : 0
  spec.series.forEach((s, j) => {
    s.values.forEach((v, i) => {
      if (v === null || v <= 0) return
      const left = i * slot + (slot - group) / 2 + (j * group) / m
      const height = Math.max(1.5, (v / hi) * (bottom - top))
      rect(c, left + gap / 2, bottom - height, left + group / m - gap / 2, bottom, colorOf(j))
    })
  })
  const slotCells = columns / n
  const widest = Math.max(...spec.labels.map(l => l.length))
  const every = slotCells > widest ? 1 : Math.ceil((widest + 1) / slotCells)
  const picks = Array.from({ length: Math.ceil(n / every) }, (_, k) => k * every)

  return {
    side,
    plot: finish(c, columns, rows),
    under: under(side.columns, columns, spec.labels, picks, i => (i + 0.5) * slotCells),
  }
}

const hbars = (spec: ChartSpec, available: number, budget: number): Picture => {
  const m = spec.series.length
  const per = m > 1 ? m + 1 : 1
  const n = Math.min(spec.labels.length, Math.floor(60 / per))
  const rows = n * per - (m > 1 ? 1 : 0)
  const max = Math.max(0, ...numbers(spec)) || 1
  const names = Math.min(Math.max(...spec.labels.slice(0, n).map(l => l.length)), Math.floor(available * 0.35))
  const texts = spec.series.map(s => s.values.map(v => (v === null ? '' : fmt(v, spec.unit))))
  const widest = Math.max(...texts.flat().map(t => t.length))
  const g = makeGrid(names + 1 + widest + 1, rows)
  const columns = Math.max(4, Math.min(255, available - g.columns))
  const c = canvas(columns, rows, budget)
  for (let i = 0; i < n; i++) {
    write(g, 0, i * per, clip(spec.labels[i] ?? '', names).padStart(names), DEFAULT)
    spec.series.forEach((s, j) => {
      const v = s.values[i]
      if (v === null || v === undefined) return
      const y = (i * per + j) * c.cellH
      write(g, names + 1, i * per + j, (texts[j]?.[i] ?? '').padStart(widest), DIM)
      if (v > 0) rect(c, 0, y + c.cellH * 0.16, Math.max(2, (v / max) * c.width), y + c.cellH * 0.84, colorOf(j))
    })
  }

  return { side: pack(g), plot: finish(c, columns, rows) }
}

/** Whether the vertical bars of a spec have room: at least two cells a bar; a spec without it is drawn as lines. */
const isBarsFitting = (spec: ChartSpec, columns: number) =>
  (columns - 8) / (spec.labels.length * spec.series.length) >= 1.5

export const picture = (spec: ChartSpec, available: number, budget = TREE_BUDGET): Picture => {
  const columns = Math.min(120, Math.max(36, Math.floor(available)))
  if (spec.kind === 'hbars') return hbars(spec, columns, budget)
  if (spec.kind === 'bars' && isBarsFitting(spec, columns)) return bars(spec, columns, budget)

  return line(spec, columns, budget)
}
