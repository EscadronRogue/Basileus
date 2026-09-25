# Basileus Rules

<!-- Generated from ui/rules.js by `npm run build:rules-doc`; edit that file instead. -->

A game for 3 to 5 players. Each leads a noble dynasty of the Byzantine Empire, grows rich from its offices and estates, and plots for the throne while invaders close in.

## Goal

The game lasts a set number of rounds (9 unless you choose otherwise). When it ends, each dynasty scores 1 point for every 10% it holds of all the gold, estate income and office income in the game, up to 10 points in each. The highest total wins.

If an invasion takes Constantinople, the empire falls and the game ends at once: nobody wins.

## Symbols

- **Troops**: raised by offices every round, and hired as mercenaries.
- **Gold**: paid by estates, bishoprics and dismissed troops; spent on estates and mercenaries.
- **Support**: what decides the coup: troops in Constantinople and the other sources of support.
- **Estate**: a circle in the dynasty's colour on a province, with the number of estates it holds there.
- **Strategos**: a square on a province; hollow while no Strategos is appointed.
- **Bishopric**: a triangle on a province that has a church; hollow while it has no Bishop.
- **Lost province**: faded markers and a "Lost" tag: the province is held by invaders.

## Game Start

- **The map** has provinces around Constantinople in three regions: East, West and Sea. On the Classic map there are 40; 14 of them are bishoprics and 13 start the game lost to invaders; the others are imperial. See Maps for the Compact map.
- **Offices.** One dynasty, drawn at random, starts as Basileus. The four major offices (Domestic of the East, Domestic of the West, Admiral, Patriarch) are dealt to the other dynasties. No Strategos, Bishop or estate exists yet.
- **Gold.** Every dynasty receives 4 gold with the first income.

## Maps

Choose the map when you set up a game. The rules are the same on both.

- **Classic:** 40 provinces, 14 of them bishoprics; 13 start lost.
- **Compact:** 21 provinces, 7 of them bishoprics; 7 start lost. Every province raises 1 troop, so armies, invasions and income are smaller. Values that differ from the Classic map: starting gold 3 (Classic 4); estate revocations by the Basileus per round 2 (Classic 4); most mercenaries a dynasty can hire 6 (Classic 10); Theodosian Walls 2 (Classic 3); Patriarch's influence 1.5 (Classic 2.5); Unrest per lost province 1 (Classic 2); invasion strength added every round 1 (Classic 2). Everything else is the same.

## A Round

Each round has four phases. Before the first, a new invasion is drawn and shown on the map with its route and its strength.

1. **Offices.** If the last coup crowned a new Basileus, they first hand out the four major offices. Then the Domestics and the Admiral appoint and revoke Strategoi in their region and the Patriarch appoints and revokes Bishops: up to two actions per major office. The Basileus may revoke estates, up to four times. Each dynasty locks when done; then income is paid.
2. **Estates.** Each dynasty secretly plans the estates it builds this round.
3. **Deployment.** Each dynasty secretly sends its armies to the frontier or to Constantinople, hires mercenaries and chooses who it backs in the coup.
4. **Resolution.** All orders are revealed. The coup is decided first, then the war is fought. Then the next round begins.

## Income

Paid at the end of the Offices phase. Only imperial provinces produce troops and estate gold.

- **Strategos:** 1 troop from their province.
- **Domestic of the East / West, Admiral:** 1 troop per imperial province of their region, whether or not it has a Strategos.
- **Basileus:** 1 troop per 3 imperial provinces, rounded down.
- **Patriarch:** 1 gold per imperial bishopric.
- **Bishop:** 1 gold per bishopric they hold, even a lost one.
- **Estates:** 1 gold per estate in an imperial province, and 1 more for each domain (every three estates a dynasty holds in one province).

Troops are used in the Deployment phase of the same round; troops not sent anywhere are dismissed for gold.

## Offices

- **Appointing.** A Strategos can only be appointed in an imperial province, a Bishop in any bishopric. A dynasty may hold any number of minor offices, including through its own appointments.
- **No repeats.** An office cannot appoint the same dynasty twice in a row: appointing another dynasty unlocks the first again. The same holds for revoking the same target twice in a row.
- **Revoking.** A Domestic or the Admiral may revoke the Strategoi of their region, the Patriarch any Bishop. Only the Basileus revokes estates, and cannot revoke anything else: one revocation takes all of one dynasty's estates in one province, even those built last round, with no refund.
- **Lost provinces.** No Strategos can be appointed in a lost province, and its Strategos and estates cannot be revoked: they stay on record and work again when the province is retaken. Its Bishop can still be appointed and revoked.
- **Major offices** only change hands when a new Basileus hands them all out.

## Estates

- **Building.** Every estate costs 3 gold, however many a dynasty builds. Estates can only be built in imperial provinces.
- **Any number.** A province can hold any number of estates, owned by any dynasties.
- **Domains.** Every three estates a dynasty holds in one province form a domain, which pays 1 more gold every income: three estates there pay 4, six pay 8. A domain is also a bigger target: one revocation by the Basileus takes all of a dynasty's estates in a province, and a lost province pays nothing.
- **Secret.** Plans stay hidden until Deployment opens, when every plan is paid and built at once. New estates can be revoked from the next Offices phase.

## Deployment

- **Armies.** Each office's troops form one army; a dynasty's Strategos troops form one army together. Send each army to the frontier or to Constantinople, and choose how many of its troops to field.
- **Dismissed troops** are the troops you do not field: they pay you 1 gold each instead.
- **Mercenaries** cost 3 gold each, up to 10. They all go to the same place.
- **Coup choices.** Choose up to two claimants to the throne, yourself allowed. Your troops in Constantinople give all their support to your first choice and 50% to your second.

## The Coup

The claimant with the most support becomes Basileus from the next round. If nobody has any support, the Basileus stays.

- **Troops in Constantinople** follow their dynasty's choices: all to the first, 50% to the second.
- **Theodosian Walls:** the Basileus always has 3 support. The Walls also defend Constantinople in war (see The War).
- **Patriarch's influence:** 2.5 support that follows the Patriarch's choices like troops.
- **Triumph:** support for the best defender of the last war (see The War).
- **Unrest:** a Basileus who lost provinces in the last war has 2 less support per lost province.
- **Ties** go to the claimant with more of the Patriarch's influence, then to the Basileus, then to the first in seating order.

## The War

All troops at the frontier fight the invasion. Its strength is known when it is drawn: 2 for every imperial province on its route (the farther the empire reaches toward the invader, the stronger it is), plus 2 for every round of the game so far (the threat grows every round).

- **Invader stronger.** What the invader beats the frontier by pays for its route, step by step: 3 to take each imperial province; land already lost offers no resistance. It stops at the first step it cannot pay for.
- **Constantinople** ends some routes. It costs the invader 3 plus the Theodosian Walls (3). If the invader can pay for it too, the empire falls and nobody wins.
- **Frontier stronger.** Its lead retakes lost provinces on the route, 3 each, starting from the end nearest Constantinople.
- **The ladder.** The "+N" tags on the map show what each step of the route costs the invader. The invasion card adds them up: how many troops hold every province, and how many save Constantinople.
- **Best defender.** When the frontier wins, the dynasty with the most troops there earns 3 gold and 3 Triumph for each province of the route the lead could pay for at 3 each, lost or not. Tied dynasties share: gold rounded up, Triumph rounded down.

## End of the Game

After the last round's Resolution, a final Offices phase is played (after the major offices are handed out if the throne changed) and income is paid. Then the Balance of Power is scored: 1 point per 10% share of gold, estate income, office income, up to 10 points each. Gold counts what each dynasty holds; the two incomes count the final income.

## Glossary

- **Basileus** (office): The emperor. Hands out the 4 major offices on taking the throne, is the only one who can revoke estates (up to 4 revocations in each Offices phase, and nothing else), raises 1 troop per 3 imperial provinces, and has the Theodosian Walls in every coup.
- **Major office** (office): One of the 4 great offices below the throne: Domestic of the East, Domestic of the West, Admiral and Patriarch. Only a new Basileus hands them out again.
- **Minor office** (office): A Strategos or a Bishop: one of each per province at most, appointed and revoked by a major office in the Offices phase.
- **Domestic** (office): Commands the eastern or the western provinces: appoints and revokes their Strategoi (up to 2 actions per Offices phase) and raises 1 troop per imperial province of the region.
- **Admiral** (office): Commands the sea provinces: appoints and revokes their Strategoi (up to 2 actions per Offices phase) and raises 1 troop per imperial sea province.
- **Patriarch** (office): Head of the Church: appoints and revokes Bishops (up to 2 actions per Offices phase), receives 1 gold per imperial bishopric, and brings the Patriarch's influence to every coup.
- **Strategos** (office): Governor of one province, appointed by the Domestic or Admiral of its region. Raises 1 troop there while the province is imperial. All of a dynasty's Strategos troops march as one army.
- **Bishop** (office): Holds one bishopric, appointed by the Patriarch. Receives 1 gold from it every income, even while it is lost.
- **Bishopric** (map): A province with a church, marked with a triangle on the map. Only bishoprics have Bishops.
- **Appointment** (offices): Giving a Strategos or Bishop office to a dynasty. An office cannot appoint the same dynasty twice in a row; appointing another dynasty unlocks the first again.
- **Revocation** (offices): Taking away a Strategos (by the Domestic or Admiral of the region) or a Bishop (by the Patriarch), or all of one dynasty's estates in one province, domain and all (by the Basileus only). A Strategos or estates in a lost province cannot be revoked.
- **Offices** (phase): The first phase of a round. A new Basileus first hands out the major offices; then the major offices appoint and revoke, and the Basileus may revoke estates. Income is paid when every dynasty has locked.
- **Income** (phase): Paid at the end of the Offices phase: troops to Strategoi, Domestics, the Admiral and the Basileus; gold to Bishops, the Patriarch and estate owners. Lost provinces produce no troops and no estate gold.
- **Estate** (economy): Land a dynasty owns in a province: pays it 1 gold every income while the province is imperial. A province can hold any number of estates of any dynasties. In the Estates phase each dynasty secretly plans new ones, at 3 gold each.
- **Domain** (economy): Every 3 estates a dynasty holds in one province: pays 1 more gold every income. A domain is also a bigger target, since one revocation takes all of a dynasty's estates in a province.
- **Deployment** (phase): Each dynasty secretly sends its armies to the frontier or to Constantinople, dismisses the troops it does not field, hires mercenaries and makes its coup choices.
- **Resolution** (phase): Orders are revealed. The coup is decided first, then the war is fought.
- **Final reckoning** (phase): After the last round, a final Offices phase and income, then the Balance of Power is scored.
- **Troop** (army): Raised by offices at every income and used in the same round's Deployment: fielded at the frontier or in Constantinople, or dismissed for gold.
- **Dismissed troops** (army): Troops a dynasty does not field in Deployment. Each pays it 1 gold instead.
- **Mercenaries** (army): Troops hired with gold in Deployment, 3 gold each, up to 10. All go to the same place.
- **Frontier** (army): Where the war is fought: the troops every dynasty sends there are added up against the invasion.
- **Constantinople** (army): The capital. Troops sent there support claimants in the coup instead of fighting. If an invasion takes it, the empire falls.
- **Coup** (throne): Decided in every Resolution, before the war: the claimant with the most support becomes Basileus from the next round. If nobody has support, the Basileus stays. A tie goes to the claimant with more of the Patriarch's influence, then to the Basileus.
- **Support** (throne): What decides the coup: troops in Constantinople (following their coup choices), the Theodosian Walls, the Patriarch's influence, Triumph and Unrest.
- **Coup choices** (throne): Up to two claimants a dynasty backs, itself allowed: its troops in Constantinople give all their support to the first and 50% to the second. With no choice, they back nobody.
- **Theodosian Walls** (throne): The walls of Constantinople: 3 support for the Basileus in every coup, and 3 more strength an invader needs to take Constantinople.
- **Patriarch's influence** (throne): 2.5 support in every coup that follows the Patriarch's coup choices like troops: all to the first choice, half to the second.
- **Triumph** (throne): Support for the best defender of the last war, for that dynasty itself, in the next coup only: 3 for each province won.
- **Unrest** (throne): 2 less support per province lost in the last war, for the Basileus who lost them, in the next coup only.
- **Invasion** (war): This round's enemy: a route of provinces, shown on the map, and a strength known when it is drawn: 2 for every imperial province on its route, plus 2 for every round so far. If it beats the frontier, it takes provinces along its route.
- **Invasion ladder** (war): What each step of an invasion's route costs the invader, out of what it beats the frontier by: 3 to take an imperial province, nothing to cross a lost one, and 3 plus the Theodosian Walls for Constantinople. Shown as "+N" tags on the map; the invasion card adds them up.
- **Imperial province** (map): A province the empire holds. Only imperial provinces raise troops and pay estate gold.
- **Lost province** (map): A province held by invaders. Its Strategos and estates stay on record but produce nothing, and cannot be revoked, until the empire retakes it. Its Bishop is still paid.
- **Reconquest** (war): When the frontier wins, its lead retakes lost provinces on the route, 3 each, starting from the end nearest Constantinople.
- **Best defender** (war): The dynasty with the most troops at the frontier in a won war. For each province of the route the frontier's lead could pay for (3 each), lost or not, it gets 3 gold and 3 Triumph.
- **Fall of the empire** (war): If an invasion takes Constantinople, the game ends at once and nobody wins.
- **Balance of Power** (scoring): How the game is won: 1 point per 10% share of all the gold, estate income and office income, up to 10 points each. The two incomes are those of the final income.
