# charts

A Claude Code mod that lets Claude draw charts in your terminal.

When you ask for numbers (analytics, a SQL result, a CSV), Claude fetches the
data as usual and passes the rows to the mod's `draw` tool. The chart appears in
a **Charts** pane beside the conversation, newest on top.

- Three kinds: line (trends), vertical bars (a few buckets), horizontal bars
  (named categories such as countries, events or funnel steps).
- Up to 6 series per chart; the pane keeps the last 4 charts.
- In terminals with the kitty graphics protocol (Ghostty, kitty) charts are
  drawn as real pixels. Everywhere else, and in sessions that cannot draw
  images, they are drawn with braille and block characters.
- On a terminal too narrow for the pane to open by itself, the chart is drawn
  inline in the transcript instead.

## Install

At the Claude Code prompt in a terminal:

```
/plugin install charts --marketplace JorgeRomero123/claude-charts
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session).

## Use

Ask Claude for data you want to see, for example "chart signups per day for the
last 30 days". Type `/charts` to reopen the pane; it also retries pixel images.
The pane's Clear button (hotkey `c` while the pane has focus) empties it.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The mod API is early access and may change between Claude Code releases.

## License

MIT
