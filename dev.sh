#!/bin/bash
# dev.sh - Development runner for MuzsikApp

set -e

echo "🚀 Starting MuzsikApp in DEVELOPMENT mode..."

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    exit 1
fi

# Ensure we are in the project root for npx commands
cd "$SCRIPT_DIR"

# Check for .env files
if [ ! -f backend/.env ]; then
  echo "⚠️  Warning: backend/.env not found. Copying from backend/.env.example..."
  cp backend/.env.example backend/.env
fi

if [ ! -f frontend/.env ]; then
  echo "⚠️  Warning: frontend/.env not found. Copying from frontend/.env.example..."
  cp frontend/.env.example frontend/.env
fi

# Start both services using concurrently (installed in root)
echo "📦 Launching backend and frontend with hot-reload..."
echo "   Backend: src/muzsikapp/backend"
echo "   Frontend: src/muzsikapp/frontend"
echo ""

# Use npx to run concurrently from the root
npx concurrently --kill-others \
  --names "BACKEND,FRONTEND" \
  --prefix "[{name}]" \
  "cd backend && npm run dev" \
  "cd frontend && npm run dev"
