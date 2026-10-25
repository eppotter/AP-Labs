# test/acceptance

End-to-end tests. The core test: two forks differ only by profile and modules.

- `two-forks.test.js` (Story 11.3): builds two client forks in temp dirs as real copies of the repo (`makeCopyFork` in `test/fixtures/temp-fork.js`: no example client, only `node_modules` linked), from the fixture clients `test/fixtures/fork/` and `test/fixtures/fork-b/`. It checks with `kit/lib/fork` that every engine file is byte-identical and that only the profiles, contexts, app dirs and one appended dependency differ; boots each fork's own runtime offline with a fake Slack client and checks each shows its own client name, menu and access; and runs the tier CLI, `npm run verify` and the write gate in each fork against its own profile. Offline, about 15 seconds; both forks are removed at the end.

Tests read client specifics from fixtures, never from a client's paths.
