# Basileus — Rule Update Patch

Definitive specification of the rule changes. Implementation order is given at the end. No code in this document.

---

## 1. Turn structure

The current sequence `invasion → administration → court → orders → resolution → cleanup` is replaced with:

1. **Invasion** — unchanged. Draws the new invader.
2. **Title redistribution** — *new interactive phase*. Basileus only.
3. **Income** — formerly `administration`. Renamed and rewritten.
4. **Court** — appointments, revocations, and church gifts (one action per player).
5. **Estates** — bidding for private land. Split out of court so deals during court do not interleave with auctions.
6. **Deployment** — funding sliders, mercenary recruitment, capital/frontier destination.
7. **Resolution** — coup + war (unchanged in structure).
8. **Cleanup** — minimal; clear per-turn state.

The post-coup major-title purge code path is dissolved. A new Basileus simply runs Phase 2 on his first turn. `state.pendingTitleReassignment` becomes dead state and is removed.

---

## 2. Players & roster

The game supports 3–5 players. The existing balance rule continues to apply:

- Every non-Basileus player holds at least one major title.
- No player holds more than two major titles.
- Resulting distributions: 3p → 2-2; 4p → 2-1-1; 5p → 1-1-1-1.

There are no spectator / free-citizen players. The same `MAJOR_TITLE_DISTRIBUTION` table and `validateMajorTitleAssignments` validator remain canonical.

When a single player holds two major titles (3p and 4p cases), their action rights are the *union* of both roles' rights — but they still get only **one action per turn**.

---

## 3. Action rights — specialization matrix

One action per player per turn during Phase 4. The action permitted is determined strictly by the player's role(s):

| Role | May appoint | May revoke | May gift land to church |
|---|---|---|---|
| Basileus | Empress; Chief of Eunuchs | Empress; Chief of Eunuchs; private land; church land | If they own private land |
| Domestic East | Strategos in East region | Strategos in East region | If they own private land (any region) |
| Domestic West | Strategos in West region | Strategos in West region | If they own private land (any region) |
| Admiral | Strategos in Sea region | Strategos in Sea region | If they own private land (any region) |
| Patriarch | Bishop, any province with `origin.C ≥ 1` (empire or occupied) | Bishop, any province | If they own private land (any region) |

All actions are free. The Basileus may no longer appoint or revoke strategoi, and may no longer revoke bishops. Domestics and the Admiral are strictly limited to their region.

**Cross-player locks (kept):**
- A title appointed this turn cannot be revoked this turn (any player).
- A title revoked this turn cannot be appointed this turn (any player).
- A player cannot self-appoint two turns in a row to the same slot.
- A revoker cannot revoke the same target two turns in a row.

**Intra-role locks (dropped):** the previous "revoked X → cannot appoint X this turn" rule is subsumed by the 1-action constraint and is removed.

---

## 4. Symbol rename: `L` → `T`

The province troop value is named `T` everywhere. The old `T` (tax) is removed, freeing the letter. The rename is global and atomic — partial states will silently corrupt the cascade.

Renames (non-exhaustive):

- `data/provinces.js`: each province loses its old `T` field; the old `L` field is renamed `T`.
- `engine/cascade.js`: `computeRegionalLevyCascade` → `computeRegionalTroopCascade`; `regionalLevyPools` → `regionalTroopPools`.
- `engine/turnflow.js`, `engine/actions.js`, `engine/state.js`: `state.currentLevies` → `state.currentTroops`; office-keyed maps follow.
- `engine/rules.js`: drop `getThemeTaxIncome`; rename any `getThemeLevyCount` to `getThemeTroopCount`.
- `engine/presentation.js`, `ui/labels.js`: `formatLevies` → `formatTroops` (consolidate with the existing mercenary formatter); all user-facing strings switch from "levy/levies" to "troop/troops".
- `engine/history.js`: event payload field `levies` → `troops`; remove all `tax_*` event types.
- `ai/brain.js`, `ai/legalActions.js`, `ai/opponentRoster.js`: identifier renames.
- All `*.test.js`: fixtures, assertions, names.
- Multiplayer wire formats: any field named `levies` becomes `troops`. Bump a wire-protocol version constant if you have one.

Do this rename in one self-contained pass before any other change.

---

## 5. Province economics

Rewrite `data/provinces.js`:

- Every province (except CPL): `P: 1`, `T: 1`, `C: 0`.
- Provinces that previously had `C: 2`: keep `C: 1` instead.
- All other fields (region, coordinates, `startOccupied`, adjacency) unchanged.
- **CPL**: no `P`, no `T`, no `C` fields at all. Engine treats CPL as having no economic flow. UI must not display any economic value on CPL.

At setup, snapshot every province's original economic stats into `theme.origin = { P, T, C }`. The live `theme.P / theme.T / theme.C` are mutated by church gifts; `origin` is immutable and is the source of truth for restoration on church-land revoke, on reconquest, and for the "is this province eligible for a bishop?" check (`origin.C ≥ 1`).

Private estate purchase no longer decreases the province troop value. Drop `theme.privateLevyReduced` and the `-1 L` mutation in `settleLandAuctions` / `revokeTheme`.

Tax is gone end-to-end. No tax pools, no CPL cascade, no `tax` category in `incomeBreakdown`.

---

## 6. Phase 2 — Title redistribution

Runs every turn after Invasion is drawn, before Income.

- Only the Basileus interacts; the UI is locked for everyone else.
- The current major-title distribution is preloaded into the editor.
- The Basileus may keep it unchanged (one-click "Confirm current") or shuffle freely subject to the balance rule (§2). The current `validateMajorTitleAssignments` is reused.
- The submitter is the standing Basileus; the helper `suggestMajorTitleAssignments` becomes the default-preload generator instead of a one-shot post-coup helper.
- On confirm, advance immediately to Income.
- AI: if the Basileus is AI, generate a redistribution choice via the same helper plus a stability bias (prefer minimal disturbance unless a heuristic clearly favours change).

The professional-army handover inside `applyCoupTitleReassignment` (the `extractOfficeArmy` / `assignOfficeArmy` block) is deleted along with professional armies (§14). The function is repurposed for "every-turn redistribution" or split into `applyTitleRedistribution` for clarity.

---

## 7. Phase 3 — Income

Per-province contributions, computed in one pass over `state.themes`:

- **Occupied province**: nothing flows, *except* a bishop seated there collects `theme.origin.C` gold directly (the lost-land bishop path). Private "ghost" ownership produces nothing while suspended (§11).
- **Church-owned province** (`theme.owner === 'church'`): the full inflated `theme.C` (= origin.P + origin.T + origin.C) goes to the bishop seated there if any, else to the church pool. No troops, no profit.
- **Strategos seat with a private owner**: profit `theme.P` → owner; troops `theme.T` → strategos directly; church value `theme.C` → bishop seated there if any, else the church pool.
- **Strategos seat without a private owner**: troops to strategos; profit forfeited; church as above.
- **No strategos, has private owner**: profit → owner; troops contribute to the regional pool; church as above.
- **No strategos, no owner**: troops to regional pool; church as above.

Regional troop pool distribution (per region, repeated until the pool is empty): 2 to the regional Domestic/Admiral, then 1 to the Basileus. If the regional title is vacant, the 2 fall through to the Basileus too.

Church pool distribution: 100% to the Patriarch. Bishops are *not* paid from the pool — they are paid per-province, before the pool is computed (so per-province C never enters the pool). The previous Patriarch-2 / bishops-1 cascade is removed.

**Court-title cost (Basileus only):** after the normal income is computed, for each currently filled court title (Empress, Chief of Eunuchs), subtract 1 troop from the Basileus's income and add 1 capital-locked troop to the Basileus. The capital-lock is recorded on the BASILEUS army key as a separate sub-pool (e.g. `currentTroops['BASILEUS'].capitalLocked`) so the deployment UI can disable the destination slider for that sub-pool. These troops regenerate every income regardless of last turn's funding decision.

`runAdministration` is renamed `runIncome`. The function still returns `{ income, incomeBreakdown, troops }`; `incomeBreakdown` drops `tax` and keeps `estate` and `church`.

---

## 8. Phase 4 — Court (appointments, revocations, gifts)

UI: one action panel per player, role-filtered to show only legal options. Each player picks one of {appoint, revoke, gift land, skip}, then submits. No more multi-action grids.

State: `state.courtActions.actionUsed[playerId] = true` upon any chosen action; every engine function that performs an action checks and sets this flag.

Removed entirely from `engine/actions.js`:

- Escalating revocation costs: `getNextRevocationCost`, `canPayRevocationCost`, `payRevocationCost`, `recordRevocationCostUse`, `getBasileusAvailableTroops`, `getPlayerAvailableRevocationTroops`.
- Escalating appointment costs: `getNextAppointmentCost`, `canPayAppointmentCost`, `payAppointmentCost`, `recordAppointmentCostUse` (cost portion; the choice-record portion is kept under a renamed helper that still feeds the self-appointment lock).
- Patriarch gold-based bishop costs: `getPatriarchBishopAppointmentGoldCost`, `canPayPatriarchBishopAppointmentCost`, `payPatriarchBishopAppointmentCost`, `getPatriarchBishopRevocationGoldCost`, `canPayPatriarchBishopRevocationCost`, `payPatriarchBishopRevocationCost`.
- Suspended professionals: `restoreSuspendedProfessionals`, `getSuspendedProfessionalCount`, `state.suspendedProfessionals`, `getPlayerProfessionalUpkeep`.
- Office-key collation helpers: `getPlayerControlledOfficeKeys`, `getPlayerAvailableAppointmentTroops`.

Authority gates tighten:

- `appointStrategos`: gate on regional Domestic/Admiral only. Remove the `appointerId !== state.basileusId` escape clause.
- `appointBishop`: Patriarch only. Allow `theme.occupied === true` provided `theme.origin.C ≥ 1`.
- `appointCourtTitle`: Basileus only (unchanged). Marks Basileus's action used.
- `revokeMinorTitle` strategos branch: regional Domestic/Admiral only. Basileus loses access. `canPlayerRevokeStrategos` drops its Basileus short-circuit.
- `revokeMinorTitle` bishop branch: Patriarch only. `canPlayerRevokeBishop` drops its Basileus short-circuit.
- `revokeCourtTitle`: Basileus only (unchanged).
- `revokeTheme`: Basileus only (unchanged).
- **New** `revokeChurchLand(state, themeId, revokerId)`: Basileus only. Restores `theme.P/T/C` from `theme.origin`; sets `theme.owner = null`; clears the bishop slot (`theme.bishop = null`, `theme.bishopIsDonor = false`). Standard cross-player locks still apply.

Same-turn cross-player locks (`appointedThisTurn`, `revokedThisTurn` — add the second one) are recorded by slot key on each action and consulted by the opposite action.

---

## 9. Phase 4 (cont.) — Church gifts; Phase 5 — Estates

**Church gift** (any player, in Phase 4, consumes their action):

- Preconditions: the gifting player owns the province privately, the province is not occupied, `theme.origin.C ≥ 1`.
- Effects:
  - `theme.owner = 'church'`
  - `theme.bishop = playerId`; `theme.bishopIsDonor = true`
  - `theme.C = theme.origin.P + theme.origin.T + theme.origin.C`
  - `theme.P = 0`; `theme.T = 0`
  - Any pre-existing bishop on this province is **displaced** to a random empire province satisfying: `origin.C ≥ 1`, `theme.bishop == null`, `theme.owner !== 'church'`, `!theme.occupied`. If no candidate exists, the displaced bishop is unseated.
- Reversal: only the Basileus, via `revokeChurchLand` (§8). The donor does not retain any privileged claim.

**Estates** (Phase 5 in the new ordering — split out of Court so deals do not interleave with bids):

- Bidding: unchanged in mechanics; `buyTheme` and the auction state are preserved.
- Settlement: `settleLandAuctions` runs at end of Phase 5. **Remove** the `theme.L -= 1` block and `theme.privateLevyReduced` field.
- Estate bidding does not consume the player's Phase 4 action.

"Privileges" mentioned in the new phase label is **out of scope for this patch**. Phase 5 is "Estates" only until a privileges mechanic is specified.

---

## 10. Phase 6 — Deployment

UI presents one army card per army the player controls, plus exactly one mercenary card. Army cards:

- `BASILEUS` (if Basileus). Includes the capital-locked sub-pool from court-title cost (§7).
- `DOM_EAST`, `DOM_WEST`, `ADMIRAL` (if held).
- `STRAT_<themeId>` per strategos seat held.
- (Patriarch never has troops under the new rules — no card.)

Each army card:

- **Funding slider** — 0 to army-size. Shows current value, max, and a live "+N gold (unfunded)" chip. Unfunded troops grant +1 gold each at submit and cannot deploy.
- **Destination slider** — snaps to Capital or Frontier. Disabled and forced to Capital for capital-locked sub-pools.

Mercenary card:

- **Recruitment slider** — 0 to 10. Shows total cost via the existing `getMercenaryHireCost(0, n)` curve. Live "−N gold" chip.
- **Destination slider** — snaps to Capital or Frontier.

Live sliders are projections only. All deltas (gold gained from unfunded, gold spent on mercenaries) commit atomically at submit.

`submitOrders` payload becomes:

```
{
  armies: {
    [officeKey]: { funded: int, destination: 'capital' | 'frontier' }
  },
  mercenaries: { count: int, destination: 'capital' | 'frontier' },
  candidate: playerId
}
```

`buildPlayerResolutionContribution` reads only `funded` (not the army's total size) when summing troops, and adds `mercenaries.count`. Capital-locked sub-pools always count as `capital` regardless of submitted destination.

Mercenary recruitment counts as one army. Mercenaries cannot be added to other armies. The `MERCENARY_COMPANY_KEY` constant and `getPlayerMercenaryAssignments` are removed; replaced by `state.mercenaryOrders[playerId] = { count, destination }`.

---

## 11. Invasion, loss, reconquest

When a province is lost:

- `theme.strategos = null` (slot vacated).
- `theme.bishop` is **kept** in place. The bishop continues to collect `theme.origin.C` per income (§7).
- If `theme.owner` was a player id (private), set `theme.suspendedOwner = theme.owner` and `theme.owner = null`. The cascade and most UI treat the province as ownerless; the `suspendedOwner` is shown publicly as a "former owner" badge.
- If `theme.owner === 'church'`, the church ownership is also suspended: set `theme.suspendedOwner = 'church'`. Bishop stays seated; church flow goes through the lost-land path.
- `theme.occupied = true`.

When a province is reconquered (defender reward `empire`):

- If `theme.suspendedOwner` is set, restore it (player id → `theme.owner = playerId`; `'church'` → `theme.owner = 'church'` and `theme.C` re-inflated from `origin`). Clear `suspendedOwner`.
- Otherwise the province returns as free-citizen (`theme.owner = null`).
- Strategos slot stays vacant.
- Bishop slot is unchanged (whoever was seated continues).
- `theme.occupied = false`.

UI: occupied provinces show a small badge for the suspended owner (dynasty-coloured), visible to all players.

---

## 12. Bishops & church flow (consolidated)

- Eligibility: a province can host a bishop iff `theme.origin.C ≥ 1`. Empire/occupied status does not matter for eligibility.
- Patriarch is the sole appointer and sole revoker.
- Per-province direct pay (income phase):
  - Non-occupied, non-church-owned province with a bishop: bishop gets `theme.C` (= `origin.C`). C does not enter the pool.
  - Non-occupied, church-owned province with a bishop: bishop gets the inflated `theme.C`.
  - Occupied province with a bishop (lost-land): bishop gets `theme.origin.C`.
- Church pool: sum of `theme.C` over non-occupied provinces with no bishop, plus inflated `theme.C` from church-owned provinces with no bishop. Distributed 100% to the Patriarch. Drop the bishop seniority cascade.
- `state.bishopAppointments` registry is removed. Pay distribution does not need it. The self-appointment lock can use a simpler per-slot record on `state.courtActions.appointedThisTurn`.

---

## 13. UI / UX consistency

- All sliders share one component (track, fill, snap markers if any, live preview chip on the right). The funding, destination, and mercenary sliders look identical apart from labels.
- "Levy" / "levies" never appears in user-facing strings. Only "troop" / "troops".
- CPL: hide all P/T/C tooltip rows, hide any economic icons, hide strategos affordances.
- Title redistribution screen reuses the existing major-title reassignment widget under the title "Redistribute Major Titles". Pre-fills with the current distribution.
- Court phase: single role-filtered action panel per player. Options: Appoint (sub-menu of legal targets), Revoke (sub-menu), Gift land (sub-menu of owned eligible provinces), Skip. The panel disappears once the player's action is recorded.
- Deployment phase: vertical stack of army cards with shared layout. Mercenary card sits at the bottom, visually identical.
- Ghost-ownership indicator: small dynasty-coloured chevron on occupied provinces.

---

## 14. Removals

Delete the following code paths entirely (do not soft-disable; remove the symbols):

- Professional armies: `professionalArmies` map on every player, `pendingProfessionalArmies`, `suspendedProfessionals`, `recruitedThisRound`, `MERCENARY_COMPANY_KEY`, `getPlayerMercenaryAssignments`, `addPendingProfessionalArmies`, `extractPendingOfficeArmies`, `activatePendingProfessionalArmies`, `restoreSuspendedProfessionals`, `getSuspendedProfessionalCount`, `getPlayerProfessionalUpkeep`, `payMaintenance`, `applyDebtDisbanding`, `canRecruitProfessional`, `recruitProfessional`, `canDismissProfessional`, `dismissProfessional`, `transferOfficeArmy`, `assignOfficeArmy`, `extractOfficeArmy`, `isMercenaryCompanyOfficeKey`, `PROFESSIONAL_BANNED_OFFICES`.
- Tax flows: `regionalTaxPools`, `computeRegionalTaxCascade`, `computeCPLCascade`, `getThemeTaxIncome`, `incomeBreakdown.tax`, every `theme.T` (old tax) read and write.
- Capital-locked title levies system (`CAPITAL_LOCKED_TITLE_LEVIES`, the EMPRESS/CHIEF_EUNUCHS/PATRIARCH `addLevy` calls inside `runAdministration`, `isCapitalLockedOffice`'s use against levies) — replaced by the §7 court-title cost mechanism, which only touches Basileus.
- Escalating action costs (§8).
- `pendingTitleReassignment` and its cleanup-phase trigger (§6).
- Patriarch's gold-based bishop appointment/revocation (§8).
- Bishop seniority registry: `state.bishopAppointments`, `ensureBishopAppointments`, `registerBishopAppointment`, `removeBishopAppointment` (§12).

---

## 15. File impact matrix

| File | Edits |
|---|---|
| `data/provinces.js` | Rewrite stats per §5; drop tax field; rename L→T; CPL strips P/T/C. |
| `data/titles.js` | Untouched. |
| `engine/setup.js` | Compute and store `theme.origin = { P, T, C }`; init `state.courtActions.actionUsed = {}`; init `state.mercenaryOrders = {}`. |
| `engine/state.js` | Rename `currentLevies` → `currentTroops`; drop professional-army state; drop bishop registry; add `actionUsed`. |
| `engine/rules.js` | Drop `getThemeTaxIncome`; rename levy helpers. |
| `engine/cascade.js` | Rewrite per §7 and §12; rename and rewire troop cascade; remove tax/CPL cascade; per-province bishop pay; Basileus court-title cost. |
| `engine/actions.js` | Remove all professional/cost/maintenance helpers; tighten authority checks per §8; add `revokeChurchLand`; rewrite `giftToChurch` per §9; relocate displaced bishops; enforce `actionUsed`. |
| `engine/turnflow.js` | Add `phaseTitleRedistribution`; rename `phaseAdministration` → `phaseIncome`; split estate purchase into its own phase; rewrite `submitOrders` shape; rewrite `buildPlayerResolutionContribution` per §10; rewire `advanceToNextInteractivePhase`; remove maintenance/professional handling in `phaseCleanup`. |
| `engine/orders.js`, `engine/commands.js` | New orders schema; validation. |
| `engine/deals.js` | Drop cost-based validators; revalidate against new authority matrix; auctions only settle in Phase 5. |
| `engine/combat.js` | On loss: set `suspendedOwner`, keep bishop, clear strategos. On reconquest: restore `suspendedOwner`. |
| `engine/scoring.js` | Drop tax / professional references. |
| `engine/history.js` | Drop `tax_*`, `recruit_pro`, `dismiss_pro`, `debt_disband`; add `title_redistribution`, `church_land_revoked`, `bishop_displaced`. |
| `engine/presentation.js`, `ui/labels.js` | Renames per §4. |
| `ui/gameController.js` | New title-redistribution screen; one-action court panel; slider-card orders panel; remove army-management screens. |
| `ui/panels.js` | Slider component, army card, gift panel, action picker; remove recruit/dismiss panels. |
| `ui/balancePanel.js`, `ui/sharedView.js` | Renamed phases; removed pro/upkeep displays. |
| `render/mapRenderer.js` | Hide CPL economic markers; add `formerOwner` chevron on occupied provinces; show bishop seat on occupied provinces. |
| `ai/legalActions.js` | Regenerate from new authority matrix; drop recruit/dismiss; add gift; add title redistribution; emit slider-form orders. |
| `ai/brain.js` | Decisions for free actions; slider-form orders; budget-aware mercenary recruitment; redistribution heuristic. |
| `multiplayer/server.js`, `multiplayer/wsServer.js`, `multiplayer/service.js`, `multiplayer/session.js`, `multiplayer/verify.js` | New phase routing; new orders schema validation; bump wire version. |
| `**/*.test.js` | Fixtures (province stats), phase flow, action availability; particular focus on `engine/economy.test.js`, `ai/brain.test.js`, `ai/purge.test.js`, `multiplayer/server.test.js`, `ui/gameController.test*.js`. |

---

## 16. Decisions on points not explicitly answered

These were not directly addressed but are needed to ship. The defaults below stand unless overridden:

1. **Basileus may own private land** (the original code never forbade this). He may therefore also use the church-gift action. It still consumes his one action.
2. **"Privileges"** is out of scope for this patch; Phase 5 covers estates only.
3. **Initial state on round 1**: court titles (Empress, Chief of Eunuchs) vacant; strategoi vacant; bishops vacant; major titles seeded by the existing initial-title-assignment routine.
4. **Patriarch can revoke any bishop**, including donor-bishops. Revoking a donor-bishop leaves the land church-owned; only the Basileus undoes that via `revokeChurchLand`.
5. **Mercenary cost curve** is the existing `getMercenaryHireCost` — unchanged.
6. **Intra-role same-turn locks** ("revoked-X-can't-appoint-X") are dropped — subsumed by 1-action-per-turn. Cross-player locks stay.
7. **Patriarch appointing on a filled bishop slot**: not allowed. To replace, Patriarch must revoke first, which uses the action — replacement takes two turns.
8. **Donor-bishop displacement candidate set**: empire-only, `origin.C ≥ 1`, no current bishop, not currently church-owned, not occupied.
9. **Church-owned land reconquered after loss**: restored as church-owned (`theme.owner = 'church'`, `theme.C` re-inflated from origin). The bishop slot remains as it was at the moment of loss — i.e. bishops persist through the entire loss/reconquest cycle, consistent with §11.
10. **Ghost-ownership visibility**: public — all players see the former-owner badge.
11. **`state.bishopAppointments`** registry is removed (no longer needed for pay).
12. **Patriarch holds no army of his own** in the new ruleset (capital-locked Patriarch levies are removed in §14). The Patriarch's only troop interaction is via any strategos seat he happens to hold concurrently (3p/4p only).
13. **Mercenary destination slider**: capital/frontier snap, identical to other army destination sliders.
14. **Coup tie-break**: unchanged — incumbent Basileus wins ties.

---

## Implementation order (safe sequence)

1. Province data rewrite (§5) + `theme.origin` snapshot + `L → T` rename (§4).
2. Remove tax and professional code paths (§14).
3. New phase plumbing: title redistribution, split estates out of court (§1, §6); add `actionUsed` tracking and `mercenaryOrders` state.
4. Cascade rewrite for income (§7); per-province bishop direct pay (§12); Basileus court-title cost (§7).
5. Authority tightening for appointments/revocations (§8); new `revokeChurchLand`; rewrite `giftToChurch` (§9).
6. Deployment slider orders + `buildPlayerResolutionContribution` rewrite (§10).
7. Invasion / reconquest claim tracking (§11).
8. UI rebuild: title redistribution screen, single-action court panel, slider army cards, ghost-ownership badge (§13).
9. AI rewrite (`legalActions.js`, `brain.js`); regenerate test fixtures.
10. Multiplayer wire format + server validation; bump version.

Each step should compile and pass an isolated test pass before the next step begins. Steps 1 and 2 in particular should not be mixed — the rename should land cleanly before any structural changes, so review diffs stay small.
