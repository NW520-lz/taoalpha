# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (not created yet).
- **`docs/DECISIONS.md`**: this repo's ADRs, kept as `ADR-NNN` sections in one file. Read the entries that touch the area you're about to work in.
- **`docs/INVARIANTS.md`**: properties (`I-NN`) that no change may break.

If a file doesn't exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill creates `GLOSSARY.md` lazily when terms actually get resolved.

## File structure

Single-context repo:

```
/
├── GLOSSARY.md            ← created lazily
├── docs/
│   ├── DECISIONS.md       ← ADR-NNN sections; append new ADRs here, no docs/adr/ directory
│   └── INVARIANTS.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR and invariant conflicts

If your output contradicts an existing ADR or invariant, surface it explicitly rather than silently overriding:

> _Contradicts ADR-005 (…), but worth reopening because…_

Changing an invariant additionally requires a recorded user confirmation first (see the closing rule of `docs/INVARIANTS.md`).
