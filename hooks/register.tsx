import { atom, read, update } from 'claude-code'
import type { Elements, Register } from 'claude-code'

import { colorOf, draw, hex, normalize } from './chart'
import type { ChartSpec } from './chart'
import { TREE_BUDGET, picture } from './picture'
import type { Picture } from './picture'

const TOOL = 'mcp__charts__draw'
const PANE = 'charts'
const KEPT = 4
const shown = atom({ plugin: 'charts', key: 'shown' } as const, [])
const isAltOnly = atom({ plugin: 'charts', key: 'isAltOnly' } as const, false)

const DESCRIPTION = [
  'Draws a chart in the Charts pane of the terminal, for the person to look at; the pane keeps the last few, newest on top.',
  'Use it whenever numbers are worth seeing rather than reading: a metric over time, a breakdown, a funnel, a before/after.',
  'Fetch and aggregate the data first (PostHog, SQL, a file), then pass the rows here; this tool fetches nothing.',
  'kind "line": a trend over ordered labels (dates), up to 6 series.',
  'kind "bars": vertical bars for a few ordered buckets.',
  'kind "hbars": horizontal bars for categories with names (countries, devices, events, funnel steps), sorted before passing.',
  'After it draws, say in one or two sentences what the chart shows; do not repeat the numbers as a table.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What is measured and over what period, e.g. "Image uploads per day, last 30 days".' },
    kind: { type: 'string', enum: ['line', 'bars', 'hbars'] },
    labels: { type: 'array', items: { type: 'string' }, description: 'The x values or category names, in order; short (dates as "Oct 3").' },
    series: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          values: { type: 'array', items: { type: ['number', 'null'] }, description: 'One per label; null for a missing point.' },
        },
        required: ['name', 'values'],
      },
    },
    unit: { type: 'string', description: 'A suffix for the values, e.g. "%".' },
    note: { type: 'string', description: 'One short line under the chart: the source, a filter, a caveat.' },
  },
  required: ['title', 'kind', 'labels', 'series'],
}

/** Terminals that draw pictures (the kitty graphics protocol); elsewhere an Image is only its `alt`. */
const isDrawingPictures = (program: string | undefined, term: string | undefined, kitty: string | undefined) =>
  kitty !== undefined || program === 'ghostty' || /kitty|ghostty/.test(term ?? '')

/** Rasterized pictures by spec and width: a transcript row is drawn again on every scroll and resize. */
const pictures = new Map<string, Picture>()

const pictureOf = (spec: ChartSpec, columns: number, budget: number) => {
  const key = `${columns}:${budget}:${JSON.stringify(spec)}`
  let made = pictures.get(key)
  if (made === undefined) {
    if (pictures.size >= 24) pictures.clear()
    made = picture(spec, columns, budget)
    pictures.set(key, made)
  }

  return made
}

const parsed = (output: unknown): unknown => {
  if (typeof output !== 'string') return output
  try {
    return JSON.parse(output)
  } catch {
    return undefined
  }
}

const whereOf = (output: unknown) => (parsed(output) as { where?: unknown } | null | undefined)?.where

/**
 * The site and source each Image was last drawn at. Some sessions cannot draw
 * pictures though the terminal can, and nothing says so while drawing: a blit
 * of the same picture is refused there, naming the reason.
 */
const drawn = new Map<string, { requestId: string; plot: Picture['plot'] }>()

const chartOf = (output: unknown): ChartSpec | undefined => {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const chart = (value as { chart?: unknown } | null)?.chart
  if (chart === null || typeof chart !== 'object') return undefined
  const spec = normalize(chart as Record<string, unknown>)

  return typeof spec === 'string' ? undefined : spec
}

/**
 * One chart as a terminal tree: its title, the plot (pixels where the terminal
 * draws pictures, cells elsewhere), the legend and the note. `id` keeps the
 * keys of several charts in one tree apart.
 */
const chartTree = (
  els: Elements['terminal'],
  spec: ChartSpec,
  columns: number,
  isPictures: boolean,
  id: string,
  budget = TREE_BUDGET,
  requestId = PANE,
) => {
  const { Box, Text, Raster, Image } = els
  const made = isPictures ? pictureOf(spec, columns, budget) : undefined
  if (made !== undefined) drawn.set(`plot-${id}`, { requestId, plot: made.plot })
  const drawing = made === undefined ? draw(spec, columns) : undefined

  return (
    <Box flexDirection="column">
      <Text bold>{spec.title}</Text>
      {drawing !== undefined && (
        <Raster key={`plot-${id}`} columns={drawing.columns} rows={drawing.rows} cells={drawing.cells} />
      )}
      {made !== undefined && (
        <Box flexDirection="row">
          <Raster key={`side-${id}`} columns={made.side.columns} rows={made.side.rows} cells={made.side.cells} />
          <Image
            key={`plot-${id}`}
            source={{ rgba: made.plot.rgba, width: made.plot.width, height: made.plot.height }}
            columns={made.plot.columns}
            rows={made.plot.rows}
            alt={spec.title}
          />
        </Box>
      )}
      {made?.under !== undefined && (
        <Raster key={`under-${id}`} columns={made.under.columns} rows={made.under.rows} cells={made.under.cells} />
      )}
      {spec.series.length > 1 && (
        <Box flexDirection="row">
          {spec.series.map((s, i) => (
            <Text color={hex(colorOf(i))}>{`\u25a0 ${s.name}   `}</Text>
          ))}
        </Box>
      )}
      {spec.note !== undefined && <Text dimColor>{spec.note}</Text>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'draw', description: DESCRIPTION, inputSchema: SCHEMA })
    await $.command.register({ name: 'charts', description: 'Show the Charts pane' })
    // A resumed or reloaded session may draw pictures where the last one could not: try them anew.
    await update($, isAltOnly, () => false)

    return next(e)
  })

  on('command.run', { command: 'charts' }, async $ => {
    // The session may draw pictures again (another terminal, another way of running): try them anew.
    await update($, isAltOnly, () => false)
    await $.ui.open({ id: PANE, title: 'Charts' })

    return { text: 'Charts pane opened.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const spec = normalize(e as unknown as Record<string, unknown>)
    if (typeof spec === 'string') return { deny: spec }
    await update($, shown, list => [spec, ...list].slice(0, KEPT))
    // Opened unasked, the pane seats only on a wide terminal; where it waits, the chart is drawn in the transcript.
    const opened = await $.ui.open({ id: PANE, title: 'Charts' })

    // A plugin tool answers the model in text: the spec as JSON, which the ToolResult hook parses back.
    // Once the picture has had time to be drawn, ask whether it was; the answer redraws every chart in cells.
    $.clock.after(700, async () => {
      for (const [key, { requestId, plot }] of drawn) {
        const { deny } = await $.ui.blit({ requestId, key, source: { rgba: plot.rgba, width: plot.width, height: plot.height } })
        if (deny?.includes('alt')) {
          drawn.clear()
          await update($, isAltOnly, () => true)
          break
        }
      }
    })

    // A plugin tool answers the model in text: the spec as JSON, which the ToolResult hook parses back.
    return { result: JSON.stringify({ where: opened.isPlaced ? 'pane' : 'transcript', chart: spec }) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, shown)
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)

      return <Text>{`${list.length} chart${list.length === 1 ? '' : 's'}; they draw in the terminal only.`}</Text>
    }
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    if (list.length === 0) return <Text dimColor>No charts yet. Ask for some numbers.</Text>
    const isPictures = !(await read($, isAltOnly)) &&
      isDrawingPictures(
        await $.env.get('TERM_PROGRAM'),
        await $.env.get('TERM'),
        await $.env.get('KITTY_WINDOW_ID'),
      )
    const columns = e.props.bodyColumns - 1

    return (
      <Box flexDirection="column">
        {list.map((spec, i) => (
          <Box flexDirection="column" marginBottom={1}>
            {chartTree(els, spec, columns, isPictures, String(i), Math.floor(TREE_BUDGET / list.length))}
          </Box>
        ))}
        <Button key="clear" label="Clear" hotkey="c" onPress={() => void update($, shown, () => [])} />
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored) return next(e)
    const spec = chartOf(e.props.output)
    if (spec === undefined) return next(e)
    const els = $.ui.resolve(e)
    if (whereOf(e.props.output) === 'pane') {
      const { Text } = els

      return <Text dimColor>{`${spec.title}: in the Charts pane (/charts shows it)`}</Text>
    }

    const isPictures = !(await read($, isAltOnly)) &&
      isDrawingPictures(
        await $.env.get('TERM_PROGRAM'),
        await $.env.get('TERM'),
        await $.env.get('KITTY_WINDOW_ID'),
      )

    return chartTree(els, spec, (e.viewport?.columns ?? 80) - 8, isPictures, `row-${e.requestId}`, TREE_BUDGET, e.requestId)
  })
}
