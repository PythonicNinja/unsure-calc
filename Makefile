DEV_PORT ?= 8000
AUDIT_URL ?= http://localhost:$(DEV_PORT)/

.PHONY: dev
dev:
	@echo "Serving ./ at http://localhost:$(DEV_PORT) (open for UI)"
	python3 -m http.server $(DEV_PORT)

.PHONY: test
test:
	node --test core/tests/*.test.js

.PHONY: dev_ray
dev_ray:
	cd raycast-extension && npm run dev

# Lighthouse (desktop preset, headless Chrome). Override target: make audit AUDIT_URL="https://calc.pythonic.ninja/"
.PHONY: audit
audit:
	npx --yes lighthouse@latest "$(AUDIT_URL)" --preset=desktop --quiet \
	  --chrome-flags="--headless=new" --output=json --output=html --output-path=./lighthouse-report
