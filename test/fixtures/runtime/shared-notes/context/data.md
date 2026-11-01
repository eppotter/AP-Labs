---
owner: Frontmatter Owner Sentinel
signed_off: pending
updated: 2026-10-25
---

# Data canon

Visits are cleaning appointments; DATA_PROSE_KEPT.

```sql
SELECT zone FROM visits -- SQL_FENCE_KEPT
```

<!--
A commented template example:
```truth
id: commented-truth
run: ["duckdb", "-c", "SELECT COMMENTED_TRUTH_SQL"]
expect: 111222
```
COMMENT_TEXT_SENTINEL
-->

## Known truths

```truth
id: active-clients
statement: Active clients at the end of September
run: ["duckdb", "-c", "SELECT count(*) FROM TRUTH_SQL_SENTINEL"]
expect: 987654
owner: Pat
signed_off: pending
```

~~~ truth
id: tilde-truth
run: ["duckdb", "-c", "SELECT TILDE_TRUTH_SQL"]
expect: 333444
~~~

````markdown
An example of a truth block, quoted inside another fence:
```truth
id: nested
run: ["duckdb", "-c", "SELECT NESTED_TRUTH_SQL"]
expect: 555666
```
````

AFTER_TRUTHS_KEPT.

```truth
id: unclosed
run: ["duckdb", "-c", "SELECT UNCLOSED_TRUTH_SQL"]
expect: 777888
