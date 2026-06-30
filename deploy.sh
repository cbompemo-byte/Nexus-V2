#!/bin/bash
# Deploys to Vercel production using a token (bypasses root-owned CLI config files)
# Usage: VERCEL_TOKEN=xxx bash deploy.sh

set -e

if [ -z "$VERCEL_TOKEN" ]; then
  echo "❌ VERCEL_TOKEN not set."
  echo ""
  echo "Get a token at: vercel.com/account/tokens"
  echo "Then run: VERCEL_TOKEN=your_token bash deploy.sh"
  exit 1
fi

echo "→ Deploying nexus-v2 to Vercel production..."

# Link project if not already done
if [ ! -f ".vercel/project.json" ]; then
  echo "→ Linking project..."
  VERCEL_TOKEN=$VERCEL_TOKEN npx vercel@latest link --yes --token "$VERCEL_TOKEN"
fi

# Deploy to production
npx vercel@latest --prod --yes --token "$VERCEL_TOKEN"
