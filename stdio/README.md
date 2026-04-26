## Key Modes 

| Mode | stdin | stdout | stderr | PTY? |
|---|---|---|---|---|
| default (auto-TTY) | terminal ✓ | FIFO ✗ | FIFO ✗ | No |
| `-w` / `--write` | terminal ✓ | passthrough ✓ | FIFO ✗ | No |
| `--raw` | terminal ✓ | passthrough ✓ | suppressed | No |
| `-i` / `--interactive` *(new)* | terminal ✓ | terminal ✓ | terminal ✓ | Yes |

## Environment Variables

| Environment Variable | Default | Description |
|---|---|---|
| `ACTUATOR_JOBS_DIR` | `/tmp/actuator-jobs` | Job storage directory |
| `ACTUATOR_STATUS_INTERVAL` | `5` | Status update interval in seconds |
| `ACTUATOR_POLL_INTERVAL` | `10` | Streaming poll interval in seconds |
| `ACTUATOR_OUTPUT_SIZE_THRESHOLD` | `23000` | Stdout offload threshold in bytes |
| `ACTUATOR_STDERR_SIZE_THRESHOLD` | `5000` | Stderr offload threshold in bytes |
| `ACTUATOR_STREAM_LINES` | `0` | Max lines to emit during streaming (0 = unlimited) |
| `ACTUATOR_STREAM_TIMESTAMPS` | `false` | Add timestamps to stream events |
| `ACTUATOR_SEQ_VERBOSE_ONLY` | `false` | Suppress SEQ field unless `--verbose` set |
| `ACTUATOR_TRACK_TOKENS` | `false` | Append token estimates to `.token_log` |
| `ACTUATOR_COMPRESS_OUTPUT` | `false` | Compress command output using tool-aware parsers |
| `ACTUATOR_CLEANUP_THRESHOLD` | `1000` | Auto-evict oldest finished jobs when total exceeds this on `--list` (0 = disabled) |
| `ACTUATOR_EVICT_COUNT` | `500` | Number of oldest finished jobs to remove per auto-eviction |
