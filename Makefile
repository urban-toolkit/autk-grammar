# Modules — add new module directories here as they are created
MODULES := grammar adapters/autk

.PHONY: build install clean lint typecheck \
        grammar adapters/autk \
        grammar-lint adapters/autk-lint \
        grammar-typecheck adapters/autk-typecheck \
        grammar-clean adapters/autk-clean

## Build all modules
build: grammar adapters/autk

grammar:
	npm run build --prefix grammar

adapters/autk:
	npm run build --prefix adapters/autk

## Install dependencies for all modules
install:
	npm install

## Lint all modules
lint: grammar-lint adapters/autk-lint

grammar-lint:
	npm run lint --prefix grammar

adapters/autk-lint:
	npm run lint --prefix adapters/autk

## Typecheck all modules
typecheck: grammar-typecheck adapters/autk-typecheck

grammar-typecheck:
	npm run typecheck --prefix grammar

adapters/autk-typecheck:
	npm run typecheck --prefix adapters/autk

## Remove dist output from all modules
clean: grammar-clean adapters/autk-clean

grammar-clean:
	rm -rf grammar/dist

adapters/autk-clean:
	rm -rf adapters/autk/dist
