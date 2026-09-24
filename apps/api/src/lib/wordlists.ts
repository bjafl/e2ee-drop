// apps/api/src/lib/wordlists.ts
export type CodewordLocale = "en" | "nb";
export const DEFAULT_LOCALE: CodewordLocale = "en";

const EN: string[] = [
  "fox", "wolf", "bear", "deer", "stoat", "lynx", "mole", "mouse", "otter", "badger", "rabbit", "squirrel", "hedgehog", "raccoon", "beaver", "elk",
  "owl", "hawk", "crow", "swan", "duck", "goose", "robin", "sparrow", "eagle", "falcon", "heron", "stork", "magpie", "raven", "dove", "wren",
  "fish", "seal", "whale", "shark", "crab", "clam", "squid", "eel", "trout", "salmon", "perch", "pike", "shrimp", "mussel", "starfish", "jellyfish",
  "ant", "bee", "wasp", "moth", "fly", "beetle", "cricket", "spider", "ladybug", "dragonfly", "grasshopper", "firefly", "snail", "mite", "worm", "mosquito",
  "oak", "pine", "birch", "maple", "elm", "willow", "cedar", "spruce", "fern", "moss", "reed", "thistle", "clover", "ivy", "bamboo", "cactus",
  "apple", "pear", "plum", "peach", "cherry", "grape", "lemon", "orange", "melon", "currant", "fig", "mango", "kiwi", "apricot", "olive", "walnut",
  "carrot", "potato", "onion", "garlic", "cabbage", "leek", "radish", "turnip", "beet", "pumpkin", "celery", "spinach", "lettuce", "parsley", "bean", "yam",
  "bread", "butter", "cheese", "honey", "sugar", "salt", "pepper", "grain", "rice", "oat", "wheat", "syrup", "jam", "broth", "soup", "tea",
  "river", "lake", "ocean", "cloud", "storm", "rain", "snow", "frost", "fog", "wind", "thunder", "rainbow", "valley", "hill", "cliff", "cave",
  "forest", "meadow", "desert", "island", "mountain", "glacier", "canyon", "marsh", "dune", "coast", "star", "moon", "comet", "planet", "dawn", "dusk",
  "chair", "table", "lamp", "mirror", "pillow", "blanket", "carpet", "curtain", "shelf", "drawer", "basket", "candle", "vase", "clock", "broom", "bucket",
  "hammer", "nail", "screw", "wrench", "saw", "drill", "chisel", "ladder", "rope", "anchor", "hook", "blade", "axe", "shovel", "rake", "pliers",
  "scarf", "glove", "hat", "boot", "coat", "jacket", "sock", "belt", "button", "ribbon", "cape", "apron", "mitten", "sandal", "cloak", "veil",
  "finger", "elbow", "ankle", "shoulder", "wrist", "cheek", "chin", "jaw", "wagon", "sled", "canoe", "raft", "barge", "kayak", "ferry", "tram",
  "bridge", "tower", "castle", "cabin", "barn", "mill", "harbor", "market", "chapel", "cottage", "iron", "copper", "silver", "gold", "marble", "clay",
  "key", "lock", "coin", "bell", "flag", "kite", "drum", "flute", "mask", "ring", "crown", "shield", "lantern", "compass", "feather", "pebble",
];

const NB: string[] = [
  "rev", "ulv", "bjørn", "hjort", "røyskatt", "gaupe", "muldvarp", "mus", "oter", "grevling", "kanin", "ekorn", "pinnsvin", "vaskebjørn", "bever", "elg",
  "ugle", "hauk", "kråke", "svane", "and", "gås", "rødstrupe", "spurv", "ørn", "falk", "hegre", "stork", "skjære", "ravn", "due", "gjerdesmett",
  "fisk", "sel", "hval", "hai", "krabbe", "musling", "blekksprut", "ål", "ørret", "laks", "abbor", "gjedde", "reke", "blåskjell", "sjøstjerne", "manet",
  "maur", "bie", "veps", "møll", "flue", "bille", "siriss", "edderkopp", "marihøne", "øyenstikker", "gresshoppe", "sankthansorm", "snegle", "midd", "mark", "mygg",
  "eik", "furu", "bjørk", "lønn", "alm", "pil", "seder", "gran", "bregne", "mose", "siv", "tistel", "kløver", "eføy", "bambus", "kaktus",
  "eple", "pære", "plomme", "fersken", "kirsebær", "drue", "sitron", "appelsin", "melon", "rips", "fiken", "mango", "kiwi", "aprikos", "oliven", "valnøtt",
  "gulrot", "potet", "løk", "hvitløk", "kål", "purre", "reddik", "kålrot", "rødbete", "gresskar", "selleri", "spinat", "salat", "persille", "bønne", "jams",
  "brød", "smør", "ost", "honning", "sukker", "salt", "pepper", "korn", "ris", "havre", "hvete", "sirup", "syltetøy", "kraft", "suppe", "te",
  "elv", "innsjø", "hav", "sky", "storm", "regn", "snø", "frost", "tåke", "vind", "torden", "regnbue", "dal", "ås", "klippe", "hule",
  "skog", "eng", "ørken", "øy", "fjell", "isbre", "kløft", "myr", "sanddyne", "kyst", "stjerne", "måne", "komet", "planet", "morgengry", "skumring",
  "stol", "bord", "lampe", "speil", "pute", "teppe", "matte", "gardin", "hylle", "skuff", "kurv", "lys", "vase", "klokke", "kost", "bøtte",
  "hammer", "spiker", "skrue", "skiftenøkkel", "sag", "drill", "meisel", "stige", "tau", "anker", "krok", "blad", "øks", "spade", "rake", "tang",
  "skjerf", "hanske", "hatt", "støvel", "frakk", "jakke", "sokk", "belte", "knapp", "bånd", "kappe", "forkle", "vott", "sandal", "kåpe", "slør",
  "finger", "albue", "ankel", "skulder", "håndledd", "kinn", "hake", "kjeve", "vogn", "kjelke", "kano", "flåte", "lekter", "kajakk", "ferge", "trikk",
  "bro", "tårn", "slott", "hytte", "låve", "mølle", "havn", "marked", "kapell", "landsted", "jern", "kobber", "sølv", "gull", "marmor", "leire",
  "nøkkel", "lås", "mynt", "bjelle", "flagg", "drage", "tromme", "fløyte", "maske", "ring", "krone", "skjold", "lykt", "kompass", "fjær", "småstein",
];

export const WORDLISTS: Record<CodewordLocale, string[]> = { en: EN, nb: NB };
