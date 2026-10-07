export type ChartKind = 'line' | 'bars' | 'hbars'
export type ChartSeries = { name: string; values: (number | null)[] }
export type ChartSpec = {
  title: string
  kind: ChartKind
  labels: string[]
  series: ChartSeries[]
  unit: string
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    /** The charts the pane shows, newest first. */
    charts: {
      shown: ChartSpec[]
      /** True once the surface said it draws an Image as its alt here: charts are then drawn in cells. */
      isAltOnly: boolean
    }
  }
}
