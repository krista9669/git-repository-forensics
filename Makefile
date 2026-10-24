# Git Repository Forensics — local development shortcuts.
#
#   make         same as `make run`: set up whatever is missing, then start everything
#   make setup   first-time setup: deps, .env.local, databases, schema, admin, demo repo
#   make dev     run the web app (http://localhost:3000) and the analysis worker
#   make test    recreate the test database and run all tests
#   make help    list every target

# The project needs Node >= 22. If the default `node` is older, run npm through
# a Node 22 provided by npx so nothing has to be installed globally.
NODE_MAJOR := $(shell node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
ifeq ($(shell [ $(NODE_MAJOR) -ge 22 ] && echo ok),ok)
NPM := npm
else
NPM := npx -y -p node@22 npm
endif

COMPOSE := docker compose --env-file .env.local

.DEFAULT_GOAL := run

.PHONY: run help setup install env db-up db-down db-logs migrate seed neo4j-init fixture \
        dev web worker build start test test-unit typecheck reset clean

run: node_modules .env.local db-up migrate seed neo4j-init fixtures/repos/demo ## One command: prepare whatever is missing, then start web + worker
	@echo
	@echo "Starting on http://localhost:3000  (login: $$(grep ^ADMIN_EMAIL= .env.local | cut -d= -f2) / $$(grep ^ADMIN_PASSWORD= .env.local | cut -d= -f2))"
	@$(MAKE) --no-print-directory dev

help: ## List targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-11s %s\n", $$1, $$2}'

setup: install env db-up migrate seed neo4j-init fixture ## First-time setup (safe to re-run)
	@echo
	@echo "Setup complete. Run 'make dev' and open http://localhost:3000"
	@echo "Admin login: $$(grep ^ADMIN_EMAIL= .env.local | cut -d= -f2) / $$(grep ^ADMIN_PASSWORD= .env.local | cut -d= -f2)"

install: ## Install npm dependencies
	$(NPM) install

node_modules: package.json package-lock.json
	$(NPM) install
	@touch node_modules

fixtures/repos/demo:
	$(NPM) run fixture

env: .env.local ## Create .env.local with random passwords (if missing)

.env.local:
	@P=$$(openssl rand -hex 12); N=$$(openssl rand -hex 12); R=$$(openssl rand -hex 12); A=$$(openssl rand -hex 12); \
	sed -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$$P#" -e "s#grf:CHANGE_ME@#grf:$$P@#g" \
	    -e "s#^NEO4J_PASSWORD=.*#NEO4J_PASSWORD=$$N#" \
	    -e "s#redis://:CHANGE_ME@#redis://:$$R@#" -e "s#^REDIS_PASSWORD=.*#REDIS_PASSWORD=$$R#" \
	    -e "s#^ADMIN_PASSWORD=.*#ADMIN_PASSWORD=$$A#" .env.example > .env.local
	@echo "Created .env.local with random credentials."

db-up: .env.local ## Start PostgreSQL, Neo4j and Redis and wait until healthy
	$(COMPOSE) up -d --wait

db-down: ## Stop the database containers (data is kept)
	$(COMPOSE) down

db-logs: ## Follow the database container logs
	$(COMPOSE) logs -f

migrate: ## Apply database migrations
	$(NPM) run db:migrate

seed: ## Create the initial admin account
	$(NPM) run db:seed

neo4j-init: ## Create Neo4j constraints and indexes
	$(NPM) run neo4j:init

fixture: ## Create the local "demo" repository in fixtures/repos
	$(NPM) run fixture

dev: ## Run the web app and the worker together (Ctrl+C stops both)
	@$(MAKE) --no-print-directory -j2 web worker

web: ## Run only the web app (dev mode)
	$(NPM) run dev

worker: ## Run only the analysis worker
	$(NPM) run worker

build: ## Production build
	$(NPM) run build

start: ## Serve the production build
	$(NPM) run start

test: ## Recreate the test database and run all tests
	$(NPM) run db:reset -- --test
	$(NPM) test

test-unit: ## Run unit tests only (no databases needed)
	$(NPM) run test:unit

typecheck: ## Type-check the project
	$(NPM) run typecheck

reset: db-up ## Wipe and recreate the dev database, then re-seed
	$(NPM) run db:reset
	$(NPM) run db:seed

clean: ## Remove build output and analysis workspaces
	rm -rf .next .workspaces
