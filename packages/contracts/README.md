# @offcut/contracts

`OffcutRewards` — the cumulative Merkle distributor that pays OFFCUT rewards on
Robinhood Chain (4663), plus the three scripts that put it on the chain and keep
an eye on it.

The contract itself is documented where it lives: `contracts/OffcutRewards.sol`
explains the off-chain/on-chain split, why roots are cumulative, and what the
owner can do. **It is unaudited**, which the site says in as many words, and
nothing here changes that.

## The scripts

All three take `(hre, env, io)` and are exercised by `test/deploy-scripts.test.ts`
on the in-process network, so the refusals below are tested rather than hoped
for. Every one of them prints its whole preflight **before** sending anything.

| command | what it does |
| --- | --- |
| `pnpm deploy:local` | deploy to the in-process chain (rehearsal) |
| `pnpm deploy:testnet` / `deploy:mainnet` | deploy the proxy, read it back, write `deployments/<network>.json` |
| `pnpm set-token:testnet` / `set-token:mainnet` | name the OFFCUT token, once, owner only |
| `pnpm status:local` / `status:testnet` / `status:mainnet` | read-only report; run it before and after every step |

### Environment

Nothing here ever reads a key file, prints a key, or copies one. The deployer's
key reaches hardhat through `OFFCUT_DEPLOYER_KEY` (see `hardhat.config.ts`) and
the scripts only ever know an address.

| variable | used by | notes |
| --- | --- | --- |
| `OFFCUT_DEPLOYER_KEY` | hardhat | the signing key. Owner key for `set-token`. |
| `OFFCUT_PUBLISHER_ADDRESS` | deploy | **required** on a live network, EIP-55 checksummed |
| `OFFCUT_OWNER_ADDRESS` | deploy | optional; defaults to the deployer. A different address deploys anyway (hardware wallet) but is warned about loudly |
| `OFFCUT_TOKEN_ADDRESS` | set-token | EIP-55 checksummed, must have code |
| `OFFCUT_DEPLOY_CONFIRM=mainnet` | deploy, set-token | required for any live run on chain 4663 |
| `OFFCUT_DEPLOY_DRY_RUN=1` | deploy, set-token | stop after preflight |
| `OFFCUT_DEPLOY_VERIFY=1` | deploy | run `verify` after deploying; failure never fails the deploy |
| `OFFCUT_CONTRACT_ADDRESS` | status | report on this proxy instead of the record |
| `OFFCUT_DEPLOYMENTS_DIR` | all three | read/write records somewhere else (tests use a temp dir) |

Addresses are required **checksummed**, and the check is a comparison: `getAddress`
recomputes a checksum rather than verifying one, so a lower-cased or mistyped
address would otherwise sail through. `scripts/lib/env.ts` compares the input
against the recomputed form and refuses on any difference.

### What each script refuses to do

`deploy.ts`

- refuses if the live `eth_chainId` is not the chain id the network is configured
  with — an rpc url can be repointed, a declaration cannot be trusted
- refuses if `deployments/<network>.json` exists. There is no `--force`: delete
  the file by hand if a second contract is genuinely wanted
- refuses a live chain-4663 run without `OFFCUT_DEPLOY_CONFIRM=mainnet`
- refuses if the deployer's balance is under **3x** the estimated cost — running
  out of gas between the implementation and the proxy leaves an implementation
  nothing points at
- deploys with `token = address(0)` always, then reads `owner()`, `publisher()`,
  `token()` and `paused()` back off the proxy and refuses to write a record if
  any of them disagrees with what was asked for
- prints the exact `hardhat verify` command to run next

The implementation's gas is estimated live; the proxy's cannot be (its
constructor delegatecalls `initialize` on an implementation that does not exist
yet), so that figure is a measurement — 208,362 gas locally, rounded up — and the
3x floor is what actually covers the difference on an Orbit chain.

`set-token.ts`

- refuses a token address that is not checksummed, or that has no code on it
- refuses if `token()` is already set (the contract would revert `TokenAlreadySet`)
- refuses if the configured key is not `owner()`, before spending gas on a revert
- reads the token back and only then updates the record

`status.ts` sends nothing and needs no key: owner, pending owner, publisher,
token, paused, the root index/root/timestamp, the pool balance once a token is
set, and the ETH balances of owner, publisher and deployer. A publisher at zero
ETH is called out — that is a distribution that silently stops updating.

## Tests

```
pnpm --filter @offcut/contracts test          # the whole hardhat suite
```

`test/OffcutRewards.test.ts` covers the contract; `test/deploy-scripts.test.ts`
covers the scripts, in temp directories, without touching a live rpc — the
mainnet branch is reached by telling the script it is on a live network while the
local node (already chain id 4663) answers underneath.

`tsc --noEmit` on this package reports errors that predate these scripts: under
pnpm's layout TypeScript cannot resolve `@nomicfoundation/hardhat-ethers`'
declarations (it arrives through hardhat-toolbox) and there is no `@types/mocha`,
so `hre.ethers.*` and mocha's globals are unresolved in both test files. Fixing
that means workspace-level dependency changes. The scripts go through
`scripts/lib/hre.ts`, which declares the slice of the plugin they use, so
everything under `scripts/` typechecks cleanly today.

## Launch day

The order — deploy, verify, configure the server and web, fund the proxy, set the
token, status — is written out in `deployments/README.md`, along with what each
record contains.
