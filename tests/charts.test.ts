import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__charts__draw'
const DAYS = ['Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7']

for (const kind of ['line', 'bars', 'hbars'] as const) {
  test(`a ${kind} chart is drawn as one Raster under its title`, async ($, on) => {
    mock.env(on, { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }) as never)
    const ran = await $.tool.call({
      tool: TOOL,
      title: 'Uploads per day',
      kind,
      labels: DAYS,
      series: [
        { name: 'android', values: [12, 18, 9, null, 22, 30, 27] },
        { name: 'iphone', values: [4, 6, 5, 7, 3, 9, 11] },
      ],
      note: 'PostHog, last 7 days',
    })
    expect(JSON.parse(String(ran.result))).toMatchObject({ where: 'transcript', chart: { kind, labels: DAYS } })

    const ui = await $.ui.mount({
      plugin: 'charts',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 't1',
      props: { tool_use_id: 't1', tool: TOOL, output: ran.result, isErrored: false },
      viewport: { columns: 100, rows: 40 },
    })
    const raster = await ui.find({ type: 'Raster', key: 'plot-row-t1' })
    expect(raster?.props.columns).toBe(92)
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Uploads per day' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'iphone' })).toBeDefined()
    await ui.unmount()
  })
}

test('a series with the wrong number of values is refused with the reason', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }) as never)

  const ran = await $.tool.call({
    tool: TOOL,
    title: 'Broken',
    kind: 'line',
    labels: DAYS,
    series: [{ name: 'android', values: [1, 2, 3] }],
  })
  expect(ran.deny).toMatch(/one value per label/)
})

for (const kind of ['line', 'bars', 'hbars'] as const) {
  test(`in a terminal that draws pictures, a ${kind} chart is one Image beside its labels`, async ($, on) => {
    mock.env(on, { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' })
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow' } }) as never)
    const ran = await $.tool.call({
      tool: TOOL,
      title: 'Uploads per day',
      kind,
      labels: DAYS,
      series: [{ name: 'android', values: [12, 18, 9, null, 22, 30, 27] }],
    })
    const ui = await $.ui.mount({
      plugin: 'charts',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 't2',
      props: { tool_use_id: 't2', tool: TOOL, output: ran.result, isErrored: false },
      viewport: { columns: 100, rows: 40 },
    })
    const image = await ui.find({ type: 'Image', key: 'plot-row-t2' })
    const side = await ui.find({ type: 'Raster', key: 'side-row-t2' })
    expect(Number(image?.props.columns) + Number(side?.props.columns)).toBe(92)
    expect(image?.props.rows).toBe(side?.props.rows)
    const source = image?.props.source as { rgba: string; width: number; height: number }
    expect(source.rgba.length).toBe(Math.ceil((source.width * source.height * 4) / 3) * 4)
    expect(await ui.find({ type: 'Raster', key: 'plot-row-t2' })).toBeUndefined()
    await ui.unmount()
  })
}

test('each chart drawn joins the pane, newest on top, and Clear empties it', async ($, on) => {
  mock.env(on, { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  for (const title of ['First', 'Second', 'Third', 'Fourth', 'Fifth']) {
    const ran = await $.tool.call({
      tool: TOOL,
      title,
      kind: 'line',
      labels: DAYS,
      series: [{ name: 'android', values: [12, 18, 9, null, 22, 30, 27] }],
    })
    expect(JSON.parse(String(ran.result))).toMatchObject({ where: 'pane' })
  }
  const ui = await $.ui.mount({
    plugin: 'charts',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'charts',
    props: { title: 'Charts', isFocused: false, bodyColumns: 120, placement: 'dock' } as never,
    viewport: { columns: 160, rows: 40 },
  })
  const titles = (await ui.findAll({ type: 'Text', text: /^(First|Second|Third|Fourth|Fifth)$/ })).map(t => t.text)
  expect(titles).toEqual(['Fifth', 'Fourth', 'Third', 'Second'])
  const images = await ui.findAll({ type: 'Image' })
  expect(images).toHaveLength(4)
  // One tree may hold 2 MiB of Image source in all.
  const bytes = images.reduce((sum, image) => sum + (image.props.source as { rgba: string }).rgba.length, 0)
  expect(bytes).toBeLessThan(2_097_152)
  const side = await ui.find({ type: 'Raster', key: 'side-0' })
  expect(Number(images[0]?.props.columns) + Number(side?.props.columns)).toBe(119)
  await ui.press({ key: 'clear' })
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(0)
  await ui.unmount()
})
