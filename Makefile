# Modules — add new module directories here as they are created
MODULES := grammar

.PHONY: build install clean $(MODULES)

## Build all modules
build: $(MODULES)

## Install dependencies for all modules
install:
	@for module in $(MODULES); do \
		echo "Installing $$module..."; \
		npm install --prefix $$module; \
	done

## Build targets per module
grammar:
	npm run build --prefix grammar

## Remove dist output from all modules
clean:
	@for module in $(MODULES); do \
		echo "Cleaning $$module..."; \
		rm -rf $$module/dist; \
	done
