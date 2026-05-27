# Modules — add new module directories here as they are created
MODULES := grammar adapters/autk adapters/deckgl gallery

.PHONY: build install clean lint typecheck \
        grammar adapters/autk adapters/deckgl gallery \
        grammar-lint adapters/autk-lint adapters/deckgl-lint gallery-lint \
        grammar-typecheck adapters/autk-typecheck adapters/deckgl-typecheck gallery-typecheck \
        grammar-clean adapters/autk-clean adapters/deckgl-clean gallery-clean

## Build all modules
build: grammar adapters/autk adapters/deckgl gallery

grammar:
	npm run build --prefix grammar

adapters/autk:
	npm run build --prefix adapters/autk

adapters/deckgl:
	npm run build --prefix adapters/deckgl

gallery:
	npm run build --prefix gallery

## Install dependencies for all modules
install:
	npm install

## Lint all modules
lint: grammar-lint adapters/autk-lint adapters/deckgl-lint gallery-lint

grammar-lint:
	npm run lint --prefix grammar

adapters/autk-lint:
	npm run lint --prefix adapters/autk

adapters/deckgl-lint:
	npm run lint --prefix adapters/deckgl

gallery-lint:
	npm run lint --prefix gallery

## Typecheck all modules
typecheck: grammar-typecheck adapters/autk-typecheck adapters/deckgl-typecheck gallery-typecheck

grammar-typecheck:
	npm run typecheck --prefix grammar

adapters/autk-typecheck:
	npm run typecheck --prefix adapters/autk

adapters/deckgl-typecheck:
	npm run typecheck --prefix adapters/deckgl

gallery-typecheck:
	npm run typecheck --prefix gallery

## Remove dist output from all modules
clean: grammar-clean adapters/autk-clean adapters/deckgl-clean gallery-clean

grammar-clean:
	rm -rf grammar/dist

adapters/autk-clean:
	rm -rf adapters/autk/dist

adapters/deckgl-clean:
	rm -rf adapters/deckgl/dist

gallery-clean:
	rm -rf gallery/dist
