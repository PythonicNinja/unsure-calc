# unsure-calc

[![Netlify Status](https://api.netlify.com/api/v1/badges/f20b5e07-f450-4dc8-add3-a1584a9343b7/deploy-status)](https://app.netlify.com/projects/unsure-calc/deploys)

Lightweight probabilistic calculator that lets you type ranges (with `~`) and arithmetic to see exact bounds plus simulated outcomes and a text histogram.

Deployed at: https://calc.pythonic.ninja

## Getting started
1. Install prerequisites: `node` (v18+ for `node:test`) and `python3` for the simple dev server.
2. Run `make dev` then open `http://localhost:8000` (override port with `DEV_PORT=9000 make dev`).
3. Run `make test` to execute the Node unit tests.

## Project structure
- `index.html` — UI shell that loads Tailwind and the calculator script.
- `main.js` — all calculator logic (tokenizer, shunting yard with unary minus, evaluator, histogram) shared by browser and tests.
- `tests/main.test.js` — minimal `node:test` suite covering tokenization, unary minus handling, precedence, and range evaluation.
- `Makefile` — quick commands for local dev and tests.

```mermaid
flowchart TD
    A[User Input] --> B[tokenize]
    B --> C[shuntingYard<br/>to RPN]
    C --> D[evalRpn<br/>UncertainValue]
    D --> E[formatNumber<br/>getQuantiles<br/>generateTextHistogram]
    E --> F[DOM render<br/>(main.js browser handlers)]
    subgraph Tests (node --test)
      B
      C
      D
    end
```

## Makefile cheatsheet
- `make dev` — serve the app via `python3 -m http.server $(DEV_PORT)` (defaults to 8000).
- `make test` — run the Node test suite (`node --test tests`).
