# deployments/

One JSON file per network, written by `scripts/deploy.ts` and added to by
`scripts/set-token.ts`. Nothing else writes here.

**This directory is the source of truth for the addresses everything else is
configured from.** After launch day the proxy address has to arrive, unchanged,
in four places that cannot ask the chain for it:

| where | what it needs |
| --- | --- |
| the deployment's env file on the server | `OFFCUT_CONTRACT_ADDRESS` for the publisher |
| the web build (inlined at build time) | `NEXT_PUBLIC_OFFCUT_REWARDS_ADDRESS` |
| `scripts/set-token.ts` | the proxy to call `setToken` on |
| `scripts/status.ts`, every time | the proxy to read |

Copying an address by hand from a terminal that has scrolled away is how one of
those four ends up wrong, which is why the deploy writes the file and everything
afterwards reads it.

## What is in a record

```json
{
  "network": "robinhood",
  "chainId": 4663,
  "proxy": "0x…",            // the address everything talks to, forever
  "implementation": "0x…",   // what to verify; changes on every upgrade
  "owner": "0x…",            // funds, withdraws, upgrades, pauses, setToken
  "publisher": "0x…",        // publishRoot only; the key that lives on the server
  "token": null,             // null until set-token has run
  "tokenSetAt": "…",         // added by set-token
  "tokenTxHash": "0x…",      // added by set-token (the deploy's own tx stays in txHash)
  "deployer": "0x…",
  "txHash": "0x…",
  "blockNumber": 0,
  "deployedAt": "2026-…Z",
  "explorer": { "proxy": "…", "implementation": "…", "deployTx": "…" }
}
```

`explorer` is `null` on any network with no verified explorer — the testnet has
none (see `apps/web/src/lib/chains.ts`), and a local rehearsal never carries
mainnet links even though the in-process chain answers chain id 4663 too.

A record existing is also the interlock against deploying twice: `deploy.ts`
refuses when the file is there. There is no `--force`. If a second contract is
genuinely wanted, delete the file by hand first — the slowness is the point.

`hardhat.json` is a throwaway. `pnpm deploy:local` runs against the in-process
chain, which is gone when the process exits, so delete that file before
rehearsing again.

## Launch day, in order

1. **`pnpm --filter @offcut/contracts status:mainnet`** — before anything, to see
   the wallets' ETH. (Nothing to report on yet; this run is really about the
   balances and that the rpc answers.)
2. **`OFFCUT_PUBLISHER_ADDRESS=0x… OFFCUT_DEPLOY_CONFIRM=mainnet pnpm --filter
   @offcut/contracts deploy:mainnet`** — preflight prints and refuses on anything
   odd; the proxy is deployed, read back, and recorded here.
   Rehearse it first with `OFFCUT_DEPLOY_DRY_RUN=1`, which stops after preflight.
3. **`hardhat verify --network robinhood <implementation>`** — the exact command
   is printed by the deploy. Blockscout; verification failing never means the
   deploy failed.
4. **Server and web** — the publisher's `OFFCUT_CONTRACT_ADDRESS` and the web
   build's `NEXT_PUBLIC_OFFCUT_REWARDS_ADDRESS` are set from `proxy` above, and
   the web is rebuilt because those values are inlined at build time. Another
   agent documents that step; it is not in this package.
5. **The owner transfers OFFCUT into the proxy.** Rewards cannot be claimed out
   of an empty contract, and `claim()` reverts `InsufficientBalance` if they try.
6. **`OFFCUT_TOKEN_ADDRESS=0x… OFFCUT_DEPLOY_CONFIRM=mainnet pnpm --filter
   @offcut/contracts set-token:mainnet`** — one-shot, owner only. Claims are live
   from that block.
7. **`pnpm --filter @offcut/contracts status:mainnet`** — after, to see owner,
   publisher, token, the pool balance and both wallets' gas.

Steps 5 and 6 are in that order on purpose: naming the token before the pool is
funded makes `claim()` reachable while the contract cannot pay, and every early
claimer gets a revert instead of a reward.
