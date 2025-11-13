#!/bin/bash
set -e

echo "🧪 Testing Docker Setup for Agor"
echo "================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Build base image
echo "Test 1: Building base image..."
if docker compose build agor-base > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Base image built successfully"
else
  echo -e "${RED}✗${NC} Failed to build base image"
  exit 1
fi

# Test 2: Build dev image
echo "Test 2: Building dev image..."
if docker compose build agor-dev > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Dev image built successfully"
else
  echo -e "${RED}✗${NC} Failed to build dev image"
  exit 1
fi

# Test 3: Build prod image
echo "Test 3: Building prod image..."
if docker compose -f docker-compose.prod.yml build agor-prod > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} Prod image built successfully"
else
  echo -e "${RED}✗${NC} Failed to build prod image"
  exit 1
fi

# Test 4: Check image sizes
echo ""
echo "Image Sizes:"
docker images | grep -E "agor-base|agor-dev|agor-prod" | awk '{print "  " $1 ":" $2 " - " $7 $8}'

echo ""
echo -e "${GREEN}✅ All Docker images built successfully!${NC}"
echo ""
echo "Next steps:"
echo "  make dev   # Start development environment"
echo "  make prod  # Start production environment"
