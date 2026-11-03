/** Friendly default names: "<Adjective> <Animal>", picked by xoshiro128++ seeded from a wallet address or browser id. Same lists and algorithm as FiPen's guest names. */

export const ADJECTIVES = [
  "Able", "Agile", "Amber", "Amiable", "Ample", "Upbeat", "Ardent", "Artful", "Awesome", "Balanced",
  "Beaming", "Bold", "Bouncy", "Brave", "Breezy", "Bright", "Brilliant", "Bubbly", "Calm", "Candid",
  "Careful", "Charming", "Cheerful", "Chipper", "Classy", "Clever", "Comfy", "Cosmic", "Cozy", "Curious",
  "Dandy", "Daring", "Dazzling", "Dapper", "Devoted", "Diligent", "Dreamy", "Eager", "Earnest", "Easygoing",
  "Elegant", "Epic", "Fearless", "Festive", "Fiery", "Friendly", "Gallant", "Generous", "Gentle", "Genuine",
  "Gifted", "Gleeful", "Glowing", "Golden", "Graceful", "Grand", "Grateful", "Happy", "Hardy", "Helpful",
  "Heroic", "Honest", "Hopeful", "Humble", "Jolly", "Jovial", "Joyful", "Keen", "Kind", "Lively",
  "Loyal", "Lucky", "Lucid", "Magical", "Merry", "Mighty", "Mindful", "Modest", "Nimble", "Noble",
  "Optimistic", "Patient", "Peaceful", "Peppy", "Playful", "Plucky", "Polite", "Proud", "Quick", "Quiet",
  "Radiant", "Rapid", "Ready", "Serene", "Sincere", "Sparkly", "Spirited", "Steady", "Sunny", "Swift",
  "Thoughtful", "Tidy", "Trusty", "Valiant", "Vibrant", "Vivid", "Warm", "Wise", "Witty", "Zesty",
];

export const ANIMALS = [
  "Aardvark", "Albatross", "Alpaca", "Antelope", "Armadillo", "Badger", "Beaver", "Bison", "Bluebird", "Bobcat",
  "Buffalo", "Bumblebee", "Butterfly", "Camel", "Capybara", "Cardinal", "Caribou", "Cheetah", "Chickadee", "Chinchilla",
  "Chipmunk", "Cougar", "Coyote", "Crane", "Cricket", "Deer", "Dingo", "Dolphin", "Dove", "Dragonfly",
  "Duck", "Eagle", "Elephant", "Elk", "Falcon", "Ferret", "Finch", "Firefly", "Flamingo", "Fox",
  "Frog", "Gazelle", "Gecko", "Giraffe", "Goldfish", "Goose", "Gorilla", "Hamster", "Hare", "Hawk",
  "Hedgehog", "Heron", "Hippo", "Hummingbird", "Ibex", "Iguana", "Jackrabbit", "Jaguar", "Jay", "Kangaroo",
  "Kingfisher", "Kitten", "Koala", "Ladybug", "Lark", "Lemur", "Leopard", "Lion", "Llama", "Lynx",
  "Macaw", "Manatee", "Meerkat", "Mongoose", "Moose", "Narwhal", "Newt", "Ocelot", "Octopus", "Orca",
  "Otter", "Owl", "Panda", "Panther", "Parrot", "Peacock", "Pelican", "Penguin", "Puffin", "Puma",
  "Quail", "Rabbit", "Raccoon", "Raven", "Reindeer", "Robin", "Salamander", "Seahorse", "Seal", "Sparrow",
  "Squirrel", "Starfish", "Swan", "Tiger", "Toucan", "Turtle", "Walrus", "Whale", "Wombat", "Zebra",
];

function splitmix32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function xoshiro128pp(seed: number): () => number {
  const next = splitmix32(seed);
  let a = next(), b = next(), c = next(), d = next();
  if (!(a | b | c | d)) a = 1;
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const result = (rotl((a + d) >>> 0, 7) + a) >>> 0;
    const t = (b << 9) >>> 0;
    c = (c ^ a) >>> 0;
    d = (d ^ b) >>> 0;
    b = (b ^ c) >>> 0;
    a = (a ^ d) >>> 0;
    c = (c ^ t) >>> 0;
    d = rotl(d, 11);
    return result;
  };
}

function pickIndex(next: () => number, n: number): number {
  const span = 2 ** 32;
  const limit = span - (span % n);
  let u = next() >>> 0;
  while (u >= limit) u = next() >>> 0;
  return u % n;
}

function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const ch of text.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Same wallet address (or browser id) gives the same name everywhere. */
export function guestName(seedText: string): string {
  const next = xoshiro128pp(seedOf(seedText));
  return `${ADJECTIVES[pickIndex(next, ADJECTIVES.length)]} ${ANIMALS[pickIndex(next, ANIMALS.length)]}`;
}
