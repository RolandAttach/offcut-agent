# @offcut/rewards

The accounting between what a period earned and a payment. Private to this
repository: it decides amounts, and it is imported by things that run inside the
API process, so it deliberately has no way to sign or send anything.

## The policy

**Two layers, one ledger.** A period prices two quantities that are not the same
thing and never share a denominator:

| Layer | Unit | Read from | Ceiling | Rate |
| --- | --- | --- | --- | --- |
| **Spend** | one millionth of a dollar of **confirmed** AI spend | `spendInWindow` | 10,000 tokens/day | 1 token per dollar |
| **Memory** | one **record**, written by one agent, retrieved once ever by another | `creditsInWindow` | 2,000 tokens/day | 1 token per credit |

Each has its own pool, its own pro-rata split and its own per-earner cap; the two
amounts an address earns are **added into one accrual, one root, one claim**.
They are kept apart up to that addition because a credit and a millionth of a
dollar cannot be summed — one pool over both would price whichever unit happened
to be larger that period.

Which is the sentence every surface describing this owes the reader: **somebody
running Claude Code on a subscription confirms no spend this service can see and
earns nothing from the spend layer, ever.** What they earn from is the memory
layer, when an agent that is not theirs uses a record theirs wrote.

Confirmed is the load-bearing word on the first layer: an agent reports a
generation id and the provider, not the agent, says what it cost. Once-ever is
the load-bearing word on the second: a unique constraint on `RewardCredit` means
a record earns once however many agents retrieve it, and the reader must not be
the author. Never for records written, never for agents created, never for
$OFFCUT held.

Each layer's pool is a **ceiling, not an obligation**:

```
spendPool  = min(dailyCeiling       / periodsPerDay, pointsThisPeriod  * ratePerPoint)
memoryPool = min(memoryDailyCeiling / periodsPerDay, creditsThisPeriod * ratePerCredit)
```

Three users on day one share tens of tokens because the right-hand branch binds.
A busy month cannot outrun the left-hand branch. Whatever the formula does not
allocate is simply never minted — the distributor already holds its tokens, so
an amount not accrued stays where it is.

Each pool is split pro-rata by that layer's units, and in a **ceiling-bound**
period no earner may take more than `perWorkspaceCapPerPeriod` of it. The cap is
applied per layer, before the two are added: applying one cap to the sum would
let a dominant spender borrow the memory layer's allowance to take more of the
contested one. That cap is applied
to the workspace **and** to the owner address it pays to, which is the strongest
identity here: `User.walletAddress` is one column, so an account is exactly one
payee.

**The cap is not a defence against a farm, and nothing capped per-identity can
be.** The allowance is granted per payee, so n payees are allowed n × cap out of
a pool that does not grow to match, and an address costs a registration and a
self-declared string. On the defaults, $900 of confirmed spend beside four
honest earners at $100 takes 17.36 tokens behind one address and 48.08 behind
five — 2.77× for identical spend and an identical pool, with what the cap
withheld minted instead. Read the cap as a ceiling on what one payee may be paid
for one period, not as a defence; `config.ts` carries the arithmetic, and
`accrual.test.ts` measures both figures so the claim cannot drift from the code.

What bounds a farm is the pool itself. Splitting spend across accounts does not
change how much was spent, so `min(ceiling, points × rate)` is the same number
either way, and a pro-rata split of a fixed pool pays for money that was really
spent however many addresses it arrives behind. On the memory layer the same
holds against a different cost: splitting does not change how many records
another agent actually used, and the unique constraint means a record earns once
whichever address it arrives behind.

Payout follows ownership. Agents hold keys, not wallets, so a workspace resolves
to its owner's `walletAddress` and two workspaces with one owner are one payee.
An owner who has not connected a wallet earns nothing until they do, and that
appears in the result with the layer, the units and a reason rather than being
dropped. A credit is paid to the workspace that **owns the record** — the
author's side — never to the reader's.

## The pieces

| File | Does |
| --- | --- |
| `config.ts` | Every number that decides how much may be emitted, read from the environment |
| `accrual.ts` | `accrueWindow` — one window of spend and of used memory to amounts owed per address, both layers added |
| `ledger.ts` | `recordAccruals` / `cumulativeTotals` — each period written down once, summed into a running total |
| `merkle.ts` | `buildTree` — that total as a root the distributor will verify |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OFFCUT_REWARD_DAILY_CEILING` | `10000` | Most that may be emitted in a day, in whole tokens |
| `OFFCUT_REWARD_PERIOD_MINUTES` | `10` | Length of a distribution period; must divide a day evenly |
| `OFFCUT_REWARD_RATE_PER_POINT` | `0.000001` | What one point is worth while the spend ceiling is not binding — a millionth of a token per millionth of a dollar, so one token per dollar of confirmed spend |
| `OFFCUT_REWARD_WORKSPACE_CAP` | `0.25` | Most one payee may take from a ceiling-bound period, on either layer. Not a defence against a farm — see above |
| `OFFCUT_REWARD_MEMORY_DAILY_CEILING` | `2000` | Most the memory layer may emit in a day, in whole tokens. A fifth of the spend layer's, because a record is a row and a retrieval is a query: this is the number that makes farming memory unprofitable at scale, and raising it is the single most dangerous edit in this package |
| `OFFCUT_REWARD_RATE_PER_CREDIT` | `1` | What one credit is worth while the memory ceiling is not binding — a whole token per used record |

Amounts are written in whole tokens (`10000`, `0.5`) and held as base-unit
bigints. More precision than the token has is refused rather than rounded.

## Arithmetic

Token amounts are `bigint` throughout; nothing here touches a float. Where the
pro-rata split leaves a remainder — and integer division nearly always does —
the remainder stays in the contract. Handing it to the first address or the
largest one are both "whoever sorts first wins", and neither is defensible.

## Why the tree is written twice

`packages/contracts/test/merkle.ts` builds the same tree, and this package does
not import it: that file is Hardhat test tooling and nothing that ships may
depend on it. Two implementations can drift, and a drifted Merkle builder looks
perfectly healthy right up to the moment every proof is rejected on-chain — so
`merkle.test.ts` runs the same entries through both and requires the same root
and the same proofs. The contract suite pins its builder against the deployed
verifier, so agreeing with it is agreeing with the chain.
