# 📚 Flash Panel documentation (mkdocs source)

These are the Flash Panel docs sources, buildable with [mkdocs-material](https://squid-fonts.readthedocs.io) style tooling:

```bash
cd docs/en && mkdocs build   # → ../../site-docs/en
cd docs/fa && mkdocs build   # → ../../site-docs/fa
```

- `mkdocs.yml` builds to `../../site-docs/` (NOT `site/`) so it can never clobber the
  Flash Panel landing page — keep it that way.
- Do not link users here from the READMEs; the single source of truth is
  [`README.md`](../README.md) / [`README_fa.md`](../README_fa.md).

**Project author & owner:** [CheginiSoroush](https://github.com/CheginiSoroush)
