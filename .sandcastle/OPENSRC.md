# Open Source Lookup

Sandy reads real dependency source with `opensrc` to bypass LLM training-cutoff
blind spots (ADR 0008). When framework or library behaviour matters and the
local types/docs/errors do not fully answer the question — Convex, Next.js,
React, or any npm dependency — look at the installed version's source.

Useful commands:

```bash
opensrc path convex next react
rg "some symbol" "$(opensrc path convex)"
rg "some symbol" "$(opensrc path next)"
```

Do not spend time reading upstream source for routine styling, copy changes, or
obvious app-level bugs.
