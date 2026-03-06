.PHONY: setup dev build run stop test pull

setup: ## Install dependencies and copy env file
	npm install
	@test -f .env || (cp .env.example .env && echo "Created .env — edit it with your tokens")

dev: ## Start in development mode (hot reload)
	npm run dev

build: ## Compile TypeScript
	npm run build

run: ## Start with Docker Compose
	docker compose up -d

stop: ## Stop Docker Compose
	docker compose down

test: ## Run type check, build, and tests
	npm run check
	npm run build
	npm test

pull: ## Pull latest Docker images
	docker pull ghcr.io/chocksy/gooseherd:latest
	docker pull ghcr.io/chocksy/gooseherd-sandbox:latest
