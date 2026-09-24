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

- **The map** has 40 provinces around Constantinople, in three regions: East, West and Sea. 14 of them are bishoprics. 13 provinces start the game lost to invaders; the others are imperial.
- **Offices.** One dynasty, drawn at random, starts as Basileus. The four major offices (Domestic of the East, Domestic of the West, Admiral, Patriarch) are dealt to the other dynasties. No Strategos, Bishop or estate exists yet.
- **Gold.** Every dynasty receives 4 gold with the first income.

## A Round

Each round has four phases. Before the first, a new invasion is drawn and shown on the map with its route and estimated strength.

1. **Offices.** If the last coup crowned a new Basileus, they first hand out the four major offices. Then the Domestics and the Admiral appoint and revoke Strategoi in their region and the Patriarch appoints and revokes Bishops: up to two actions per major office. The Basileus may make up to four revocations. Each dynasty locks when done; then income is paid.
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
- **Estates:** 1 gold per estate in an imperial province.

Troops are used in the Deployment phase of the same round; troops not sent anywhere are dismissed for gold.

## Offices

- **Appointing.** A Strategos can only be appointed in an imperial province, a Bishop in any bishopric. A dynasty may hold any number of minor offices, including through its own appointments.
- **No repeats.** An office cannot appoint the same dynasty twice in a row: appointing another dynasty unlocks the first again. The same holds for revoking the same target twice in a row.
- **Revoking** takes a Strategos or Bishop away. One revocation by the Basileus takes all of one dynasty's estates in one province, except those built last round, with no refund.
- **Lost provinces.** No Strategos can be appointed in a lost province, and its Strategos and estates cannot be revoked: they stay on record and work again when the province is retaken. Its Bishop can still be appointed and revoked.
- **Major offices** only change hands when a new Basileus hands them all out.

## Estates

- **Building.** Each round, a dynasty's first estate costs 1 gold, its second 2, its third 3, and so on. Estates can only be built in imperial provinces.
- **Any number.** A province can hold any number of estates, owned by any dynasties.
- **Secret.** Plans stay hidden until Deployment opens, when every plan is paid and built at once.
- **Protection.** Estates built this round cannot be revoked in the next Offices phase.

## Deployment

- **Armies.** Each office's troops form one army; a dynasty's Strategos troops form one army together. Send each army to the frontier or to Constantinople, and choose how many of its troops to field.
- **Dismissed troops** are the troops you do not field: they pay you 1 gold each instead.
- **Mercenaries** cost 1 gold for the first, then 1 more for each next one, up to 10. They all go to the same place.
- **Coup choices.** Choose up to two claimants to the throne, yourself allowed. Your troops in Constantinople give all their support to your first choice and 50% to your second.

## The Coup

The claimant with the most support becomes Basileus from the next round. If nobody has any support, the Basileus stays.

- **Troops in Constantinople** follow their dynasty's choices: all to the first, 50% to the second.
- **Theodosian Walls:** the Basileus always has 5 support.
- **Patriarch's influence:** 4 support that follows the Patriarch's choices like troops.
- **Triumph:** the best defender of the last war gets 2 support per province won (see The War).
- **Unrest:** a Basileus who lost provinces in the last war has 2 less support per lost province.
- **Ties** go to the claimant with more of the Patriarch's influence, then to the Basileus, then to the first in seating order.

## The War

All troops at the frontier fight the invasion. Its exact strength is drawn from the estimate when the war starts.

- **Invader stronger.** The invader walks its route and pays for each province it takes with the strength it has over the frontier: the first imperial province costs 1, the next 2, then 3, and so on. Lost provinces cost nothing. It stops at the first province it cannot pay for.
- **Constantinople** ends some routes. If the invader can pay for it too, the empire falls and nobody wins.
- **Frontier stronger.** Its lead retakes lost provinces on the route the same way, 1, then 2, then 3, starting from the end nearest Constantinople.
- **The ladder.** The invasion card and the "+N" tags on the map show how much the invader must beat the frontier by to take each province.
- **Best defender.** When the frontier wins, the dynasty with the most troops there gets 1 gold and 2 Triumph for each province its lead could pay for on the route, lost or not. Tied dynasties share: gold rounded up, Triumph rounded down.

## End of the Game

After the last round's Resolution, a final Offices phase is played (after the major offices are handed out if the throne changed) and income is paid. Then the Balance of Power is scored: 1 point per 10% share of gold, estate income, office income, up to 10 points each. Gold counts what each dynasty holds; the two incomes count the final income.

## Glossary

- **Basileus** (office): The emperor. Hands out the 4 major offices on taking the throne, may make up to 4 revocations of Strategoi and estates in each Offices phase, raises 1 troop per 3 imperial provinces, and has the Theodosian Walls in every coup.
- **Major office** (office): One of the 4 great offices below the throne: Domestic of the East, Domestic of the West, Admiral and Patriarch. Only a new Basileus hands them out again.
- **Minor office** (office): A Strategos or a Bishop: one of each per province at most, appointed and revoked by a major office in the Offices phase.
- **Domestic** (office): Commands the eastern or the western provinces: appoints and revokes their Strategoi (up to 2 actions per Offices phase) and raises 1 troop per imperial province of the region.
- **Admiral** (office): Commands the sea provinces: appoints and revokes their Strategoi (up to 2 actions per Offices phase) and raises 1 troop per imperial sea province.
- **Patriarch** (office): Head of the Church: appoints and revokes Bishops (up to 2 actions per Offices phase), receives 1 gold per imperial bishopric, and brings the Patriarch's influence to every coup.
- **Strategos** (office): Governor of one province, appointed by the Domestic or Admiral of its region. Raises 1 troop there while the province is imperial. All of a dynasty's Strategos troops march as one army.
- **Bishop** (office): Holds one bishopric, appointed by the Patriarch. Receives 1 gold from it every income, even while it is lost.
- **Bishopric** (map): A province with a church, marked with a triangle on the map. Only bishoprics have Bishops.
- **Appointment** (offices): Giving a Strategos or Bishop office to a dynasty. An office cannot appoint the same dynasty twice in a row; appointing another dynasty unlocks the first again.
- **Revocation** (offices): Taking away a Strategos or a Bishop, or (by the Basileus) all of one dynasty's estates in one province. Estates built last round, and a Strategos or estates in a lost province, cannot be revoked.
- **Offices** (phase): The first phase of a round. A new Basileus first hands out the major offices; then the major offices appoint and revoke, and the Basileus may revoke. Income is paid when every dynasty has locked.
- **Income** (phase): Paid at the end of the Offices phase: troops to Strategoi, Domestics, the Admiral and the Basileus; gold to Bishops, the Patriarch and estate owners. Lost provinces produce no troops and no estate gold.
- **Estate** (economy): Land a dynasty owns in a province: pays it 1 gold every income while the province is imperial. A province can hold any number of estates of any dynasties. In the Estates phase each dynasty secretly plans new ones: the first costs 1 gold that round, each next one 1 more.
- **Deployment** (phase): Each dynasty secretly sends its armies to the frontier or to Constantinople, dismisses the troops it does not field, hires mercenaries and makes its coup choices.
- **Resolution** (phase): Orders are revealed. The coup is decided first, then the war is fought.
- **Final reckoning** (phase): After the last round, a final Offices phase and income, then the Balance of Power is scored.
- **Troop** (army): Raised by offices at every income and used in the same round's Deployment: fielded at the frontier or in Constantinople, or dismissed for gold.
- **Dismissed troops** (army): Troops a dynasty does not field in Deployment. Each pays it 1 gold instead.
- **Mercenaries** (army): Troops hired with gold in Deployment: the first costs 1, each next one 1 more, up to 10. All go to the same place.
- **Frontier** (army): Where the war is fought: the troops every dynasty sends there are added up against the invasion.
- **Constantinople** (army): The capital. Troops sent there support claimants in the coup instead of fighting. If an invasion takes it, the empire falls.
- **Coup** (throne): Decided in every Resolution, before the war: the claimant with the most support becomes Basileus from the next round. If nobody has support, the Basileus stays. A tie goes to the claimant with more of the Patriarch's influence, then to the Basileus.
- **Support** (throne): What decides the coup: troops in Constantinople (following their coup choices), the Theodosian Walls, the Patriarch's influence, Triumph and Unrest.
- **Coup choices** (throne): Up to two claimants a dynasty backs, itself allowed: its troops in Constantinople give all their support to the first and 50% to the second. With no choice, they back nobody.
- **Theodosian Walls** (throne): The walls of Constantinople: 5 support for the Basileus in every coup.
- **Patriarch's influence** (throne): 4 support in every coup that follows the Patriarch's coup choices like troops: all to the first choice, half to the second.
- **Triumph** (throne): Support for the best defender of the last war: 2 per province won, for that dynasty itself, in the next coup only.
- **Unrest** (throne): 2 less support per province lost in the last war, for the Basileus who lost them, in the next coup only.
- **Invasion** (war): This round's enemy: an estimated strength and a route of provinces, shown on the map. If it beats the frontier, it takes provinces along its route.
- **Invasion ladder** (war): How much the invader must beat the frontier by to take each province on its route: 1 for the first imperial province, 1 + 2 for the second, 1 + 2 + 3 for the third, and so on; lost provinces cost nothing. Shown on the invasion card and as "+N" tags on the map.
- **Imperial province** (map): A province the empire holds. Only imperial provinces raise troops and pay estate gold.
- **Lost province** (map): A province held by invaders. Its Strategos and estates stay on record but produce nothing, and cannot be revoked, until the empire retakes it. Its Bishop is still paid.
- **Reconquest** (war): When the frontier wins, its lead retakes lost provinces on the route at the same rising cost (1, then 2, then 3...), starting from the end nearest Constantinople.
- **Best defender** (war): The dynasty with the most troops at the frontier in a won war. It gets 1 gold and 2 Triumph for each province the frontier's lead could pay for on the route.
- **Fall of the empire** (war): If an invasion takes Constantinople, the game ends at once and nobody wins.
- **Balance of Power** (scoring): How the game is won: 1 point per 10% share of all the gold, estate income and office income, up to 10 points each. The two incomes are those of the final income.
