| Mode | stdin | stdout | stderr | PTY? |
|---|---|---|---|---|
| default (auto-TTY) | terminal ✓ | FIFO ✗ | FIFO ✗ | No |
| `-w` / `--write` | terminal ✓ | passthrough ✓ | FIFO ✗ | No |
| `--raw` | terminal ✓ | passthrough ✓ | suppressed | No |
| `-i` / `--interactive` *(new)* | terminal ✓ | terminal ✓ | terminal ✓ | Yes |
