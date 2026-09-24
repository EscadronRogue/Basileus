# Basileus Rules

<!-- Generated from ui/rules.js by `npm run build:rules-doc`; edit that file instead. -->

A 3-5 player game of dynastic profiteering inside the Byzantine Empire.

## Goal

Hold the strongest balance of power when the game ends. After the last turn, Court resolves and a final income phase runs. Each dynasty then scores 1 point for every 10% share it holds of gold reserves, profit income, and office income (church plus troop income) from that final income phase, up to 10 points per category. Highest total wins.

If invaders sack Constantinople, the empire falls and everyone loses; the final standings only record who held the strongest position in the collapse.

## A Round, Step By Step

1. **Invasion drawn.** A new threat appears with a route through the provinces. During the first two rounds invasions strike at most at easy strength. Limited invasions only launch while a province on their route is still imperial; skipped invasions can be drawn again later.
2. **Title redistribution.** Only after a coup installs a new Basileus: they assign the four major titles before Court.
3. **Court.** Each dynasty may make deals or skip. Major offices may make up to two appointments or revocations in any mix; the Basileus may make up to four revocations.
4. **Income.** Estates pay gold, bishops collect church value, and offices raise troops automatically after Court.
5. **Estates.** Dynasties submit sealed bids for free-citizen land. Winning bids are revealed and settled when Deployment opens.
6. **Deployment.** Each dynasty funds office troops, hires mercenaries, chooses destinations, and ranks the claimants to the throne.
7. **Resolution.** The coup is decided first, then the war. Lost provinces become occupied; every province the empire can recover is reconquered automatically.
8. **Cleanup.** The new Basileus takes effect and the next turn begins. After the last turn, a final Court and income phase run before scoring, preceded by a title redistribution if the throne just changed hands.

## Provinces & Money

Each province outside Constantinople has three original values: **P** (profit to a private owner), **T** (troops raised by its office), and **C** (church gold). Constantinople has no provincial economy.

- **Starting purse.** Every dynasty receives 4 gold of starting income in the first round.
- **Buying land** happens in Estates through sealed bids. The owner collects that profit during Income.
- **Troops** come from the province's troop value. A province with a Strategos sends its troops to that Strategos; otherwise they flow to the regional Domestic or Admiral, then to the Basileus.
- **Church value** goes directly to the province Bishop. Unassigned church value flows to the Patriarch.
- **Occupation.** Lost provinces suspend their owner and strategos, keep their bishop, and pay only original church value to that bishop until reconquered.

## Titles & Appointments

- **Basileus** may revoke strategoi and private estates, but may not appoint minor titles or revoke bishops.
- **Domestic of the East / West** and the **Admiral** may appoint or revoke Strategoi in their region.
- **Patriarch** may appoint or revoke Bishops in any province with original C ≥ 1, even if occupied.
- **Major titles** never change in Court. They are redistributed only in the Title Redistribution phase.
- **No repeats.** A player cannot appoint the same dynasty twice in a row; appointing someone else unlocks the previous appointee again. The same revoker cannot revoke the same target twice in a row.
- **Revocations** are free and count against each office's action limit. The same title cannot be appointed and revoked in the same turn.
- **Private estates** bought in the previous turn cannot be revoked yet. When an older private estate is revoked, its owner receives 1 gold.

## Armies

- **Office troops** appear during Income and are assigned during Deployment. A player's Strategos troops deploy together as one combined Strategoi army.
- **Funding** is chosen per office. Unfunded troops stay home and pay 1 gold each to their controller.
- **Mercenaries** are hired during Deployment. Their cost rises triangularly: 1, then +2, then +3, and so on. All hired mercenaries share one destination.
- **Capital-locked troops** always defend the throne and cannot go to the frontier.
- **Passive capital support** comes from offices and acclaim, always stays in Constantinople, cannot be defunded, and never counts for scoring or office troop shares.

## Coup & War

- **Coup.** Every funded capital troop follows its owner's ranking: first place gets full support, last place gets none, and the ranks between scale evenly. A claimant can be toggled off for 0 support without changing the weights of those ranked above. The Basileus starts with 2 passive capital support and the Patriarch with 1; temporary acclaim or unrest can adjust those totals for one round. Most support wins. Ties go to the tied claimant with the most Patriarchal support, then to the sitting Basileus, then to dynasty order. A new Basileus redistributes all four major titles at the start of the next round or the final reckoning.
- **War.** Frontier troops minus invader strength. Win → reconquer occupied provinces along the route (cost 1, then +1, +1…). Lose → the invader advances along the route capturing provinces at the same rising cost. If a capital invasion reaches Constantinople, the empire falls; limited invasions stop after taking their target route.
- **Best defender.** When the empire wins the war, the top frontier contributor gains 1 gold and 1 temporary Triumph support for each province the surplus could reconquer along the route, even if none remain to restore. Tied top contributors share it equally: gold rounds up, Triumph rounds down. Triumph follows their coup ranking and applies only during the next coup.

## Phase Guides

### Assign the offices

1. As the new Basileus, give each of the four major offices to a dynasty.
2. Click an office circle, guide the rope to a dynasty, and click that dynasty to tie them together.
3. Offices decide who appoints strategoi and bishops and where troops and church gold flow. Lock the offices when every rope is tied.

### Court: appoint and revoke

1. Each office you hold can make up to two appointments or revocations; the Basileus can make up to four revocations.
2. To appoint, click a seat circle on the left, guide the rope, and click a dynasty on the right. Click a tied rope to cut it, which revokes that title.
3. Planned actions only happen when you confirm the court plan. You can also open a deal with another dynasty, or skip Court entirely.

### Estates: bid for land

1. Free provinces are sold in sealed bids. Choose an amount on any estate you want; rivals cannot see it.
2. The highest bid wins when Deployment opens, and the owner collects that province's profit (P) each income phase.
3. Gold you bid is committed until the bids settle, so keep enough for troops and mercenaries.

### Deployment: send armies

1. For each office army, choose how many troops to fund and send them to the frontier or the capital. Unfunded troops stay home and refund 1 gold each.
2. Frontier troops fight the invasion; capital troops back your ranking of claimants in the coup.
3. Rank the claimants to the throne (yourself included), optionally hire mercenaries, then lock your deployment.

### Resolution

1. The coup is decided first: capital troops follow each dynasty's ranking. Then frontier troops fight the invader.
2. If you were the best defender, choose between restoring a province to the empire or taking gold.
3. Press Continue when you have read the results.
