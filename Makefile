.PHONY: help build-base build-dev build-prod dev prod clean

help: ## Show this help message
	@echo "Agor Docker Commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Examples:"
	@echo "  make dev          # Start development environment"
	@echo "  make prod         # Start production environment"
	@echo "  make build-base   # Build shared base image"

build-base: ## Build shared base image
	docker compose build agor-base

build-dev: build-base ## Build development image
	docker compose build agor-dev

build-prod: build-base ## Build production image
	docker compose -f docker-compose.prod.yml build agor-prod

dev: ## Start development environment (daemon + UI with hot-reload)
	docker compose up

dev-build: ## Build and start development environment
	docker compose up --build

prod: ## Start production environment (daemon only, from npm)
	docker compose -f docker-compose.prod.yml up

prod-build: ## Build and start production environment
	docker compose -f docker-compose.prod.yml up --build

clean: ## Stop and remove all containers, volumes, and images
	docker compose down -v
	docker compose -f docker-compose.prod.yml down -v
	docker rmi agor-base agor-dev agor-prod 2>/dev/null || true

clean-soft: ## Stop containers but keep volumes
	docker compose down
	docker compose -f docker-compose.prod.yml down

logs-dev: ## View development logs
	docker compose logs -f agor-dev

logs-prod: ## View production logs
	docker compose -f docker-compose.prod.yml logs -f agor-prod

shell-dev: ## Open shell in development container
	docker compose exec agor-dev bash

shell-prod: ## Open shell in production container
	docker compose -f docker-compose.prod.yml exec agor-prod bash
