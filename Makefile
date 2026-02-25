DEV_PORT ?= 8000

.PHONY: dev
dev:
	@echo "Serving ./ at http://localhost:$(DEV_PORT) (open for UI)"
	python3 -m http.server $(DEV_PORT)

.PHONY: test
test:
	node --test core/tests

.PHONY: dev_ray
dev_ray:
	cd raycast-extension && npm run dev
