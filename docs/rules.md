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

## Glossary

- **Basileus** (office): The emperor. Starts every coup with 2 passive capital support, may make up to 4 revocations of Strategoi and estates in Court, and hands out the major titles after taking the throne. Troops that no Strategos, Domestic or Admiral receives flow to the Basileus.
- **Major titles** (office): The 4 great offices: Domestic of the East, Domestic of the West, Admiral and Patriarch. They never change in Court; only a new Basileus reassigns them, in Title Redistribution.
- **Domestic** (office): Commander of the eastern or western provinces. Appoints and revokes Strategoi in that region, up to 2 actions per Court, and raises the troops of its provinces that have no Strategos.
- **Admiral** (office): Commander of the sea provinces. Appoints and revokes Strategoi there, up to 2 actions per Court, and raises the troops of sea provinces that have no Strategos.
- **Patriarch** (office): Head of the Church. Appoints and revokes Bishops, collects the church gold no Bishop claims, and adds 1 passive capital support to the coup, split by the Patriarch's own ranking. Breaks coup ties.
- **Strategos** (office): Military governor of one province, appointed by the Domestic or Admiral of its region. Receives the troops that province raises (its T value). All of a dynasty's Strategos troops march as one Strategoi army.
- **Bishop** (office): Church office over one province, appointed by the Patriarch. Collects that province's church gold (its C value), even while the province is occupied.
- **Appointment** (court): Giving a Strategos or Bishop seat to a dynasty during Court. No office may appoint the same dynasty twice in a row; appointing someone else unlocks them again.
- **Revocation** (court): Taking a Strategos or Bishop seat, or a private estate, away during Court. Free, but it uses one of the office's actions. Estates bought last turn cannot be revoked yet; an older estate pays its owner 1 gold when revoked.
- **Title Redistribution** (phase): Happens only after a coup installs a new Basileus: before Court, they give each major title to a dynasty.
- **Court** (phase): The political phase. Offices appoint and revoke titles, and dynasties may negotiate deals. Nothing happens until each dynasty confirms its court plan.
- **Deal** (court): A binding agreement offered in Court: gold, estates, coup support, frontier support, promised appointments or protection from revocation. The game enforces the terms.
- **Income** (phase): Runs by itself after Court: estates pay their profit, Bishops collect church gold, and offices raise troops.
- **Estate** (economy): A province owned by a dynasty. Its owner collects the province's profit (P) every Income. Free provinces are sold by sealed bid in the Estates phase; the Basileus can revoke an estate.
- **Sealed bid** (economy): A secret offer of gold for a free province. The highest bid wins when Deployment opens. Gold you bid is set aside until then.
- **Profit (P)** (economy): The gold a province pays its private owner every Income.
- **Church (C)** (economy): The gold a province gives its Bishop every Income. Church value with no Bishop goes to the Patriarch.
- **Deployment** (phase): Each dynasty secretly funds its office troops, hires mercenaries, sends them to the frontier or the capital, and ranks the claimants to the throne.
- **Funding** (army): Office troops only march when you pay for them. Unfunded troops stay home and pay 1 gold each to their controller instead.
- **Mercenaries** (army): Troops hired with gold in Deployment. Each costs one more than the last (1, then 2, then 3...), and all of them go to the same destination.
- **Frontier** (army): Where the war is fought. Every dynasty's frontier troops add up against this round's invasion; sending none leaves the defence to the others.
- **Constantinople** (army): The seat of the throne. Troops sent to the capital vote in the coup instead of fighting. If an invasion reaches Constantinople, the empire falls.
- **Coup** (throne): The contest for the throne, decided every Resolution before the war. Capital troops support the claimants in their owner's ranking: full support to first place, none to last, scaled in between. Most support wins; ties go to the most Patriarchal support, then to the sitting Basileus.
- **Ranking** (throne): In Deployment every dynasty ranks all claimants to the throne, itself included. Its capital troops follow that ranking in the coup. A claimant can also be switched off to give it no support at all.
- **Passive capital support** (throne): Coup support that never leaves Constantinople: the Basileus's 2, the Patriarch's 1, plus any Triumph or unrest this round. It cannot be unfunded and never counts for scoring.
- **Triumph** (throne): Temporary coup support earned by the best defender: 1 for each province the war surplus could reconquer. It follows that dynasty's ranking in the next coup only.
- **Unrest** (throne): When the empire loses provinces, the Basileus has 1 less passive capital support per lost province in the next coup.
- **Invasion** (war): This round's threat: an enemy with a strength range and a route of provinces. A capital invasion that breaks through can reach Constantinople; a limited invasion stops once it has taken its route.
- **Resolution** (phase): Orders are revealed. The coup is decided first, then frontier troops fight the invasion.
- **Occupied** (war): A province taken by invaders. Its owner and Strategos are suspended and its Bishop keeps only the original church value until the empire reconquers it.
- **Reconquest** (war): When the empire wins a war, the surplus frontier troops recover occupied provinces along the route: the first costs 1 troop, the next 2, and so on.
- **Best defender** (war): The dynasty that sent the most troops to the frontier in a won war. It gains gold and Triumph, and chooses for each recovered province whether to restore it to the empire or take gold instead.
- **Fall of the empire** (war): If invaders sack Constantinople the game ends at once and every dynasty loses.
- **Balance of Power** (scoring): How the game is won. Each dynasty scores 1 point per 10% share it holds of gold reserves, profit income and office income, up to 10 points each. Highest total after the final reckoning wins.
- **Final reckoning** (phase): After the last turn, a last Court and Income phase run, then the Balance of Power is scored.
- **Usurper** (ai temperament): Wants the purple for itself. Pulls troops back to the capital whenever the frontier looks safe enough and gambles on seizing the throne.
- **Opportunist** (ai temperament): Lets the others bleed at the frontier. Keeps its troops and gold for its own schemes and only fights when the empire is truly about to fall.
- **Landlord** (ai temperament): Buys every estate it can afford and lives off the rents. Cares little who wears the crown as long as its lands stay safe.
- **Kingmaker** (ai temperament): Rarely claims the throne itself. Backs whichever claimant will pay best in offices, and remembers who kept their word.
- **Tyrant** (ai temperament): Takes power and uses it. Keeps offices for itself, strips titles from rivals, and never forgets a slight.
- **Patron** (ai temperament): Rules through favours. Hands offices to allies and backers, builds a coalition, and expects loyalty in return.
- **Strategist** (ai temperament): No fixed temperament. Weighs every move by how much it raises its own chance to win, and adapts to the table.
