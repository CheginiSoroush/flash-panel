# ⚠️ Legacy docs — pending rewrite

This folder still contains the **upstream BPB Panel documentation** (inherited from the
hard-fork). It has **not** been rewritten for Flash Panel yet: some pages still reference
BPB branding, BPB donation wallets and BPB Wizard links.

- `mkdocs.yml` builds to `../../site-docs/` (NOT `site/`) so it can never clobber the
  Flash Panel landing page — keep it that way.
- Do not link users here from the READMEs; the single source of truth is
  [`README.md`](../README.md) / [`README_fa.md`](../README_fa.md).

> Rewriting these docs for Flash Panel (wizard flow, clean-IP engine, automation suite,
> mirror update engine) is tracked in the project roadmap.
