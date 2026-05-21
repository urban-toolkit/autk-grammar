# Modules — add new module directories here as they are created
MODULES := grammar adapters/autk

.PHONY: build install clean lint typecheck

## Build all modules
build:
	@for module in $(MODULES); do \
		echo "Building $$module..."; \
		npm run build --prefix $$module; \
	done

## Install dependencies for all modules
install:
	@for module in $(MODULES); do \
		echo "Installing $$module..."; \
		npm install --prefix $$module; \
	done

## Lint all modules
lint:
	@for module in $(MODULES); do \
		echo "Linting $$module..."; \
		npm run lint --prefix $$module; \
	done

## Typecheck all modules
typecheck:
	@for module in $(MODULES); do \
		echo "Typechecking $$module..."; \
		npm run typecheck --prefix $$module; \
	done

## Remove dist output from all modules
clean:
	@for module in $(MODULES); do \
		echo "Cleaning $$module..."; \
		rm -rf $$module/dist; \
	done
