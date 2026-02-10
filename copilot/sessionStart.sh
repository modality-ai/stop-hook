#!/bin/bash

HOOK_INPUT=$(cat 2> /dev/null | sed 's/\x1b\[[0-9;]*[mK]//g' || echo "{}")

echo "$HOOK_INPUT" >> /tmp/githooks-debug.log
