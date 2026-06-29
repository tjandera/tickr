#!/bin/bash
# Start the Tickr server — run from the project root or web/ directory
cd "$(dirname "$0")"
exec ../.venv/bin/uvicorn app:app --port 3005 --log-level warning
