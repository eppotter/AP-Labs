'use strict';

// Neutral word lists for Brightside's synthetic people and places. Written for
// this fixture: no real-person datasets, nothing from any real client. First
// names are nature words; last names join two plain words (Ash + ford).

const FIRST_NAMES = [
  'Alder', 'Ash', 'Aspen', 'Bay', 'Birch', 'Briar', 'Brook', 'Cedar', 'Clay',
  'Clover', 'Coral', 'Cove', 'Dale', 'Dawn', 'Ember', 'Fern', 'Finch', 'Flint',
  'Glen', 'Hazel', 'Heath', 'Holly', 'Iris', 'Ivy', 'Jade', 'Juniper', 'Lake',
  'Lark', 'Laurel', 'Linden', 'Maple', 'Marsh', 'Meadow', 'Moss', 'Oak',
  'Olive', 'Onyx', 'Opal', 'Pine', 'Poppy', 'Quill', 'Rain', 'Reed', 'Ridge',
  'River', 'Robin', 'Rowan', 'Rue', 'Sage', 'Sky', 'Slate', 'Sorrel', 'Sparrow',
  'Stone', 'Storm', 'Sunny', 'Tansy', 'Teal', 'Thorn', 'Vale', 'Wren', 'Yarrow',
];

const LAST_PREFIXES = [
  'Amber', 'Ash', 'Black', 'Bright', 'Brook', 'Clear', 'Cliff', 'Cold', 'Copper',
  'Crane', 'Deep', 'East', 'Fair', 'Fox', 'Glass', 'Gold', 'Green', 'Grey',
  'Hart', 'High', 'Iron', 'Kings', 'Long', 'Mill', 'North', 'Oak', 'Red',
  'Rock', 'Silver', 'South', 'Still', 'Stone', 'Swift', 'West', 'White', 'Wood',
];

const LAST_SUFFIXES = [
  'bank', 'bourne', 'bridge', 'brook', 'by', 'combe', 'croft', 'dale', 'field',
  'ford', 'gate', 'hall', 'ham', 'hill', 'hurst', 'land', 'ley', 'more',
  'stead', 'ton', 'wall', 'water', 'well', 'wick', 'wood', 'worth',
];

const STREET_NAMES = [
  'Acorn', 'Apple', 'Beacon', 'Bluebell', 'Canal', 'Chapel', 'Cherry', 'Cobble',
  'Daisy', 'Elm', 'Garden', 'Hawthorn', 'Hilltop', 'Lantern', 'Lilac',
  'Market', 'Mill', 'Orchard', 'Park', 'Pebble', 'Pond', 'Quarry', 'Rose',
  'School', 'Spring', 'Station', 'Sunset', 'Tulip', 'Valley', 'Walnut',
  'Willow', 'Windmill',
];

const STREET_SUFFIXES = ['Avenue', 'Court', 'Drive', 'Lane', 'Place', 'Road', 'Street', 'Way'];

// Mailbox domains. Every one ends in .invalid (RFC 2606): never deliverable.
const EMAIL_DOMAINS = ['home.invalid', 'inbox.invalid', 'mail.invalid', 'post.invalid'];

module.exports = {
  FIRST_NAMES,
  LAST_PREFIXES,
  LAST_SUFFIXES,
  STREET_NAMES,
  STREET_SUFFIXES,
  EMAIL_DOMAINS,
};
