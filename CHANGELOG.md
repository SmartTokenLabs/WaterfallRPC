# Changelog

All notable changes to this project will be documented in this file.

## [0.9.8] - 2026-05-07

### Added

- `UniversalRpc.scheduleCatalogRefreshIfStale()` — checks whether the persisted RPC catalog is past its refresh interval and, if so, starts a deduplicated background download without blocking the caller.
- Unit tests for catalog caching with **ethers** (`WaterfallRpc.createProvider`) and **viem** (`createWaterfallTransport`), with shared fixtures under `tests/rpc-cache.fixtures.ts`.

### Changed

- Optimisation: When a cache file already exists, `UniversalRpc.getInstance()` loads it immediately and returns; stale catalogs refresh in the **background** instead of awaiting a full network merge at startup. If there is no cache yet, behavior is unchanged (still awaits the initial download).
- `needUpdate()` reads from in-memory `cachedData` when available before hitting storage.
- After a **successful** JSON-RPC response, **ethers** `WaterfallRpc` and the **viem** waterfall transport call `scheduleCatalogRefreshIfStale()` so periodic catalog updates are considered without slowing reads.

### Fixed

- Waterfall failover no longer stops on every `CALL_EXCEPTION` (ethers) or JSON-RPC **execution reverted** (viem code `3`) when the error has **no** concrete revert payload (`data` missing or not hex-encoded revert bytes). Those responses are treated as flaky endpoints and the next RPC is tried; **real** on-chain reverts (non-empty `data` including at least a 4-byte selector) still abort failover immediately.
