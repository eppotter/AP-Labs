Engine fixture for `kit/fixture/validate` and `kit/fixture/query` tests (Story 7.6). The
data is `../fixture-build/mini`, built into a temp dir by each test. `checks/` must all
pass on it; `profile.yml` forbids `shops.postal_code`, which only the check that declares
it may name.
