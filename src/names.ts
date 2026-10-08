// Names for players without a GitHub login: an adjective and an animal in camelCase, such as "braveOtter".
// The same player id always gives the same name, so the server, the device and every other player
// show one name without storing it. A GitHub login replaces it.
//
// The words come from the dictionaries of unique-names-generator 4.7.1 (MIT License, Copyright (c)
// 2018-2022 AndreaSonny, https://github.com/andreasonny83/unique-names-generator). Only friendly,
// playful words are kept: no words about politics, religion, the body, illness, death or insults,
// and no animal class names. Add a word only after the same check.
//
// 226 × 298 = 67348 names, so two players can share a name now and then. That is fine for a
// display name. Grow the lists if leaderboards show many shared names.

const ADJECTIVES = [
  'able', 'active', 'adorable', 'agreeable', 'alert', 'amazing', 'ambitious', 'amused', 'ancient',
  'artistic', 'atomic', 'awake', 'balanced', 'beautiful', 'bold', 'brainy', 'brave', 'breezy', 'bright',
  'brilliant', 'bumpy', 'busy', 'calm', 'capable', 'careful', 'casual', 'cautious', 'charming', 'cheerful',
  'chilly', 'classic', 'clever', 'cloudy', 'colorful', 'colossal', 'cool', 'cooperative', 'courageous',
  'creative', 'cuddly', 'curious', 'curly', 'cute', 'decisive', 'delicate', 'delightful', 'determined',
  'devoted', 'digital', 'dizzy', 'dynamic', 'eager', 'electric', 'elegant', 'enchanting', 'endless',
  'energetic', 'enormous', 'enthusiastic', 'exotic', 'exuberant', 'fancy', 'fantastic', 'fast', 'fierce',
  'fine', 'fluffy', 'flying', 'fortunate', 'free', 'fresh', 'friendly', 'frozen', 'fun', 'funny', 'fuzzy',
  'gentle', 'giant', 'gigantic', 'glad', 'glamorous', 'gleaming', 'glorious', 'golden', 'good', 'gorgeous',
  'graceful', 'grand', 'grateful', 'great', 'handsome', 'happy', 'helpful', 'hilarious', 'honest', 'huge',
  'hushed', 'husky', 'icy', 'ideal', 'imaginative', 'immense', 'impressive', 'incredible', 'innovative',
  'inquisitive', 'intelligent', 'jolly', 'joyous', 'juicy', 'keen', 'kind', 'large', 'lively', 'logical',
  'loyal', 'lucky', 'magic', 'magnetic', 'magnificent', 'mammoth', 'marvellous', 'melodic', 'mighty',
  'miniature', 'misty', 'modern', 'modest', 'mysterious', 'neat', 'nice', 'noble', 'nutty', 'obedient',
  'optimistic', 'patient', 'peaceful', 'perfect', 'petite', 'poised', 'polite', 'precious', 'precise',
  'pretty', 'prickly', 'proud', 'purring', 'quaint', 'quick', 'quiet', 'quintessential', 'quixotic', 'rapid',
  'rare', 'relaxed', 'reliable', 'remarkable', 'resonant', 'rich', 'ripe', 'robust', 'rolling', 'romantic',
  'round', 'royal', 'shiny', 'silky', 'silly', 'simple', 'skilled', 'sleepy', 'smart', 'smiling', 'smooth',
  'soft', 'solar', 'solid', 'sparkling', 'special', 'spectacular', 'spicy', 'splendid', 'spotless', 'spotty',
  'steady', 'sticky', 'stormy', 'striking', 'striped', 'strong', 'sunny', 'super', 'superb', 'swift', 'tall',
  'tame', 'tasty', 'tender', 'thoughtful', 'tiny', 'tremendous', 'tricky', 'tropical', 'unique', 'vast',
  'vivacious', 'vivid', 'warm', 'wee', 'whispering', 'wild', 'willowy', 'wily', 'wise', 'wispy', 'witty',
  'wonderful', 'wooden', 'worthy', 'youthful', 'yummy', 'zany', 'zealous', 'zestful', 'zesty', 'zippy',
] as const;

const ANIMALS = [
  'aardvark', 'aardwolf', 'albatross', 'alligator', 'alpaca', 'anaconda', 'angelfish', 'anglerfish', 'ant',
  'anteater', 'antelope', 'armadillo', 'baboon', 'badger', 'bandicoot', 'barnacle', 'barracuda', 'basilisk',
  'bass', 'bat', 'bear', 'beaver', 'bee', 'beetle', 'bison', 'blackbird', 'boa', 'boar', 'bobcat',
  'bobolink', 'bonobo', 'butterfly', 'buzzard', 'camel', 'capybara', 'cardinal', 'caribou', 'carp', 'cat',
  'caterpillar', 'catfish', 'centipede', 'chameleon', 'cheetah', 'chickadee', 'chicken', 'chimpanzee',
  'chinchilla', 'chipmunk', 'cicada', 'clam', 'clownfish', 'cobra', 'cod', 'condor', 'coral', 'cougar',
  'cow', 'coyote', 'crab', 'crane', 'crawdad', 'crayfish', 'cricket', 'crocodile', 'crow', 'cuckoo', 'deer',
  'dingo', 'dinosaur', 'dog', 'dolphin', 'donkey', 'dormouse', 'dove', 'dragon', 'dragonfly', 'duck',
  'eagle', 'earthworm', 'echidna', 'eel', 'egret', 'elephant', 'elk', 'emu', 'ermine', 'falcon', 'ferret',
  'finch', 'firefly', 'flamingo', 'fly', 'flyingfish', 'fox', 'frog', 'gazelle', 'gecko', 'gerbil', 'gibbon',
  'giraffe', 'goat', 'goldfish', 'goose', 'gopher', 'gorilla', 'grasshopper', 'grouse', 'guanaco', 'gull',
  'guppy', 'haddock', 'halibut', 'hamster', 'hare', 'harrier', 'hawk', 'hedgehog', 'heron', 'herring',
  'hippopotamus', 'hornet', 'horse', 'hummingbird', 'hyena', 'iguana', 'impala', 'jackal', 'jaguar', 'jay',
  'jellyfish', 'kangaroo', 'kingfisher', 'kite', 'kiwi', 'koala', 'koi', 'krill', 'ladybug', 'lamprey',
  'lark', 'lemming', 'lemur', 'leopard', 'leopon', 'limpet', 'lion', 'lizard', 'llama', 'lobster', 'locust',
  'loon', 'lungfish', 'lynx', 'macaw', 'mackerel', 'magpie', 'manatee', 'mandrill', 'marlin', 'marmoset',
  'marmot', 'marten', 'mastodon', 'meadowlark', 'meerkat', 'mink', 'minnow', 'mockingbird', 'mole',
  'mongoose', 'monkey', 'moose', 'mosquito', 'moth', 'mouse', 'mule', 'muskox', 'narwhal', 'newt',
  'nightingale', 'ocelot', 'octopus', 'opossum', 'orangutan', 'orca', 'ostrich', 'otter', 'owl', 'ox',
  'panda', 'panther', 'parakeet', 'parrot', 'parrotfish', 'partridge', 'peacock', 'pelican', 'penguin',
  'perch', 'pheasant', 'pig', 'pigeon', 'pike', 'piranha', 'platypus', 'pony', 'porcupine', 'porpoise',
  'possum', 'prawn', 'ptarmigan', 'puffin', 'puma', 'python', 'quail', 'quokka', 'rabbit', 'raccoon', 'rat',
  'rattlesnake', 'raven', 'reindeer', 'rhinoceros', 'roadrunner', 'rook', 'rooster', 'sailfish',
  'salamander', 'salmon', 'sawfish', 'scallop', 'scorpion', 'seahorse', 'shark', 'sheep', 'shrew', 'shrimp',
  'silkworm', 'skink', 'skunk', 'sloth', 'slug', 'snail', 'snake', 'snipe', 'sparrow', 'spider', 'spoonbill',
  'squid', 'squirrel', 'starfish', 'stingray', 'stoat', 'stork', 'sturgeon', 'swallow', 'swan', 'swordfish',
  'swordtail', 'tapir', 'tarantula', 'tarsier', 'tern', 'thrush', 'tiger', 'tiglon', 'toad', 'tortoise',
  'toucan', 'trout', 'tuna', 'turkey', 'turtle', 'tyrannosaurus', 'unicorn', 'vicuna', 'viper', 'vole',
  'vulture', 'wallaby', 'walrus', 'warbler', 'wasp', 'weasel', 'whale', 'whippet', 'whitefish', 'wildcat',
  'wildebeest', 'wolf', 'wolverine', 'wombat', 'woodpecker', 'worm', 'wren', 'yak', 'zebra',
] as const;

// FNV-1a: a small, fast hash that spreads similar ids over the whole range. src/avatar.ts uses it too.
export function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

const capital = (word: string) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`;

export function nameOf(playerId: string): string {
  if (playerId === '') throw new Error('a player id is empty');
  const value = hash(playerId);
  const adjective = ADJECTIVES[value % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(value / ADJECTIVES.length) % ANIMALS.length];
  if (adjective === undefined || animal === undefined) throw new Error('the name lists are empty');
  return `${adjective}${capital(animal)}`;
}
