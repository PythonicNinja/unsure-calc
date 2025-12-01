DEV_PORT ?= 8000

.PHONY: dev
dev:
	python3 -m http.server $(DEV_PORT)

.PHONY: test
test:
	node --test tests
