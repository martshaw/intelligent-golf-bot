#!/bin/bash
# Golf Bot OpenClaw Integration Setup
# Pulls credentials from KeePass, configures intelligent-golf-bot

set -e

GOLF_BOT_DIR="/Users/nautilus-air/.openclaw/workspace/golf-bot"
KEEPASS_DB="/Users/nautilus-air/Library/CloudStorage/GoogleDrive-martyshawz@gmail.com/My Drive/Password/password.kdbx"

echo "🏌️ Golf Bot Integration Setup"
echo "=========================================="

# Step 1: Navigate to golf-bot
cd "$GOLF_BOT_DIR"
echo "✅ In golf-bot directory"

# Step 2: Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  yarn install || npm install
fi

# Step 3: Create .env file with placeholder references
echo "⚙️  Creating .env configuration..."
cat > .env << 'EOF'
# Golf Bot Configuration (KeePass References)
# All real values are stored in KeePass - never hardcode

# Telegram Bot Token (stored in KeePass: golf_bot)
TELEGRAM_BOT_TOKEN=$GOLF_BOT_TOKEN

# Kilspindie Club Configuration (from KeePass golf_bot/kilspindie JSON)
GOLF_CLUB_URL=https://kilspindie.intelligentgolf.co.uk

# Booking Schedule (from KeePass notes)
# Booking triggers daily at 18:45 GMT
BOOKING_HOUR=18
BOOKING_MINUTE=45
DAYS_AHEAD_TO_BOOK=5

# Logging
LOG_LEVEL=info
EOF

echo "✅ Created .env (placeholder)"

# Step 4: Build the project
echo "🔨 Building TypeScript..."
yarn build || npm run build

echo ""
echo "✅ Golf Bot Setup Complete!"
echo ""
echo "Next Steps:"
echo "1. Update .env with actual bot token from KeePass"
echo "2. Configure golfers from KeePass JSON"
echo "3. Deploy via launchd or cron"
