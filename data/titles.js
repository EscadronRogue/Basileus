// data/titles.js — Title definitions and distribution rules

export const MAJOR_TITLES = {
  DOM_EAST:   { id: 'DOM_EAST',  name: 'Domestic of the East',  region: 'east', type: 'major' },
  DOM_WEST:   { id: 'DOM_WEST',  name: 'Domestic of the West',  region: 'west', type: 'major' },
  ADMIRAL:    { id: 'ADMIRAL',   name: 'Admiral of the Fleet',  region: 'sea',  type: 'major' },
  PATRIARCH:  { id: 'PATRIARCH', name: 'Patriarch',              region: null,   type: 'major' },
};

export const MINOR_TITLE_TYPES = {
  EMPRESS:       { id: 'EMPRESS',       name: 'Empress',           location: 'cpl', type: 'minor' },
  CHIEF_EUNUCHS: { id: 'CHIEF_EUNUCHS', name: 'Chief of Eunuchs', location: 'cpl', type: 'minor' },
  STRATEGOS:     { id: 'STRATEGOS',     name: 'Strategos',         location: 'theme', type: 'minor' },
  BISHOP:        { id: 'BISHOP',        name: 'Bishop',            location: 'theme', type: 'minor' },
};

// How many major titles each non-Basileus player gets
export const MAJOR_TITLE_DISTRIBUTION = {
  3: [2, 2],           // 2 non-Basileus players, 2 titles each
  4: [2, 1, 1],        // 3 non-Basileus players
  5: [1, 1, 1, 1],     // 4 non-Basileus players
};

// Offices that can hold troops
export const TROOP_HOLDING_OFFICES = [
  'BASILEUS', 'DOM_EAST', 'DOM_WEST', 'ADMIRAL', 'STRATEGOS'
];
