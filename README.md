# pi-extension-crit

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for inline code review feedback. Run `/crit`, review diffs in a native macOS window, leave comments on specific lines, close the window, and the agent gets your feedback automatically.

Originally created by [Daniel Griesser (HazAT)](https://github.com/HazAT) as [pi-extension-diffs](https://github.com/HazAT/pi-extension-diffs). Daniel built the entire viewer, diff rendering, native window management, and extension architecture. This fork adds the `/crit` review workflow (inline comments, feedback delivery to the agent) on top of his work.

Built on [Glimpse](https://github.com/HazAT/glimpse) (native WKWebView, also by Daniel) and [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs) (Shiki-powered syntax highlighting). Dracula theme.

## How it works

1. You (or the agent) run `/crit`
2. A native window opens showing your jj diffs — working copy changes and recent commits since trunk
3. Hover over any line in a diff and click the `+` button to leave a comment
4. Close the window when you're done
5. Comments get written to `~/.pi/crit/<repo>/<timestamp>.md` and sent to the agent as a follow-up message

So the agent reads your review feedback and acts on it. No copy-pasting, no switching contexts.

## Install

```bash
pi install pi-extension-crit
```

Or add to your pi settings manually:

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "pi-extension-crit"
  ]
}
```

Then `/reload`.

## Requirements

- **macOS** — native WKWebView window via Glimpse
- **jj** — must be in a jj repository (except when reviewing a single file with `/crit <path>`)
- **bun** — builds the viewer bundle

## Usage

```
/crit
```

Review all jj changes — working copy and recent commits since trunk.

```
/crit src/foo.ts
```

Review a single file. If the file has working copy changes in jj, shows the diff. If the file isn't in a jj repo or has no changes, shows the whole file for review.

The command blocks until you close the window. If you left comments, they're written to disk and delivered to the agent. If you didn't, it just says so and moves on.

The comment file looks like:

```markdown
# Crit — my-repo

Branch: feature/thing
Date: 2026-03-19T14:30:00.000Z

## src/foo.ts

### L42 (new)

This function should handle the nil case.

## src/bar.go

### L15 (old)

Why mutex instead of channel here?
```

## Development

```bash
git clone https://github.com/HazAT/pi-extension-crit.git
cd pi-extension-crit
npm install
npm run build
```

Point pi at your local clone:

```jsonc
{
  "packages": [
    "/path/to/pi-extension-crit"
  ]
}
```

## Tradeoffs

- The viewer bundle is ~10MB (Shiki grammars for syntax highlighting). A hidden window preloads it on startup so `/crit` opens fast, but it does eat some memory.
- The `/crit` command blocks the agent while you review. This is intentional — the agent waits for your feedback before continuing.
- Comments reference line numbers from the diff, not the final file. If lines shift between when you review and when the agent acts, the line numbers might be slightly off. The comment text gives enough context for the agent to figure it out.

## Credits

Built by [Daniel Griesser (HazAT)](https://github.com/HazAT). The diff viewer, native window management, Glimpse integration, and extension architecture are all his work from [pi-extension-diffs](https://github.com/HazAT/pi-extension-diffs). The `/crit` review workflow (inline commenting, comment persistence, agent feedback delivery, single-file review) was added by [Tom Pang](https://github.com/tom-pang).

## License

MIT
