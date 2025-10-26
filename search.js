// ==================== Enhanced Bible Verse Reference Finder ====================

// ==================== Bible Books ====================
const bibleBooks = [
    ["Genesis", ["gen", "ge"]],
    ["Exodus", ["exo", "ex"]],
    ["Leviticus", ["lev", "lv"]],
    ["Numbers", ["num", "nu"]],
    ["Deuteronomy", ["deut", "dt"]],
    ["Joshua", ["josh", "jos"]],
    ["Judges", ["judg", "jdg"]],
    ["Ruth", ["rth", "ru"]],
    ["1 Samuel", ["1sam", "i sam"]],
    ["2 Samuel", ["2sam", "ii sam"]],
    ["1 Kings", ["1kgs", "i kgs"]],
    ["2 Kings", ["2kgs", "ii kgs"]],
    ["Ezra", ["ezr"]],
    ["Nehemiah", ["neh"]],
    ["Esther", ["est"]],
    ["Job", ["job"]],
    ["Psalms", ["ps", "psa"]],
    ["Proverbs", ["prov", "prv"]],
    ["Ecclesiastes", ["eccl", "ecc"]],
    ["Song of Solomon", ["song", "sos"]],
    ["Isaiah", ["isa"]],
    ["Jeremiah", ["jer"]],
    ["Lamentations", ["lam"]],
    ["Ezekiel", ["ezek"]],
    ["Daniel", ["dan"]],
    ["Hosea", ["hos"]],
    ["Joel", ["joe"]],
    ["Amos", ["amo"]],
    ["Obadiah", ["oba"]],
    ["Jonah", ["jon"]],
    ["Micah", ["mic"]],
    ["Nahum", ["nah"]],
    ["Habakkuk", ["hab"]],
    ["Zephaniah", ["zeph"]],
    ["Haggai", ["hag"]],
    ["Zechariah", ["zech"]],
    ["Malachi", ["mal"]],
    ["Matthew", ["matt", "mt"]],
    ["Mark", ["mk"]],
    ["Luke", ["lk"]],
    ["John", ["jn"]],
    ["Acts", ["act"]],
    ["Romans", ["rom"]],
    ["1 Corinthians", ["1cor"]],
    ["2 Corinthians", ["2cor"]],
    ["Galatians", ["gal"]],
    ["Ephesians", ["eph"]],
    ["Philippians", ["phil", "php"]],
    ["Colossians", ["col"]],
    ["1 Thessalonians", ["1thess"]],
    ["2 Thessalonians", ["2thess"]],
    ["1 Timothy", ["1tim"]],
    ["2 Timothy", ["2tim"]],
    ["Titus", ["tit"]],
    ["Philemon", ["philem"]],
    ["Hebrews", ["heb"]],
    ["James", ["jam"]],
    ["1 Peter", ["1pet"]],
    ["2 Peter", ["2pet"]],
    ["1 John", ["1jn"]],
    ["2 John", ["2jn"]],
    ["3 John", ["3jn"]],
    ["Jude", ["jud"]],
    ["Revelation", ["rev"]],
];

// --- similarity helper (Levenshtein-based, 0..1) ---
function stringSimilarity(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    const longer = a.length >= b.length ? a : b;
    const shorter = a.length >= b.length ? b : a;
    if (longer.length === 0) return 1;
    const costs = Array(shorter.length + 1)
        .fill(0)
        .map((_, i) => i);
    for (let i = 1; i <= longer.length; i++) {
        let last = i;
        for (let j = 1; j <= shorter.length; j++) {
            const cost =
                longer[i - 1] === shorter[j - 1]
                ? costs[j - 1]
                : Math.min(costs[j - 1], last, costs[j]) + 1;
            costs[j - 1] = last;
            last = cost;
        }
        costs[shorter.length] = last;
    }
    const dist = costs[shorter.length];
    return (longer.length - dist) / longer.length;
}

// --- normalize: lowercase + remove spaces ---
const norm = (s) => s.toLowerCase().replace(/\s+/g, "");

// --- extract just the "book token" (before digits/colon) ---
function extractBookToken(input) {
    const cleaned = input.trim().toLowerCase();
    const match = cleaned.match(
        /^((?:[1-3]|first|second|third)\s*)?[a-z]+(?:\s+[a-z]+)*/i
    );
    return match ? match[0].trim() : "";
}

function findBibleVerseReference(input) {
    if (!input) return null;

    // --- Step 1: extract and normalize ---
    const bookTokenRaw = extractBookToken(input);
    const bookToken = norm(bookTokenRaw);
    if (!bookToken) return null;

    // --- Step 2: try to find best match among books ---
    let exactBook = null;
    let bestBook = null;
    let bestScore = 0;

    for (const [book, aliases] of bibleBooks) {
        const variants = [book, ...aliases];
        for (const v of variants) {
            const vNorm = norm(v);
            const sim = stringSimilarity(bookToken, vNorm);

            // allow s/plural
            if (bookToken.replace(/s$/, "") === vNorm.replace(/s$/, "")) {
                exactBook = book;
            }
            // numeric to word (1 -> first etc.)
            const numericToWord = { 1: "first", 2: "second", 3: "third" };
            for (const [num, word] of Object.entries(numericToWord)) {
                if (bookToken.startsWith(num) && vNorm.startsWith(word)) {
                    exactBook = book;
                }
            }
            if (bookToken === vNorm) exactBook = book;

            if (sim > bestScore) {
                bestScore = sim;
                bestBook = book;
            }
        }
    }

    // --- Step 3: parse chapter/verse/range ---
    const m = input.match(/([1-3]?\s*[A-Za-z\s]+)\s+(\d+)(?::(\d+)(?:-(\d+))?)?/);
    const chapter = m ? parseInt(m[2]) : null;
    const verse = m ? (m[3] ? parseInt(m[3]) : null) : null;
    const rangeEnd = m && m[4] ? parseInt(m[4]) : null;

    const buildRef = (bk) => {
        let r = bk;
        if (chapter) r += ` ${chapter}`;
        if (verse) r += `:${verse}`;
        if (rangeEnd) r += `-${rangeEnd}`;
        return r;
    };

    // --- Step 4: Decision logic + fallback defaults ---
    if (exactBook) {
        let finalChapter = chapter;
        let finalVerse = verse;

        // defaults
        if (!finalChapter && !finalVerse) { finalChapter = 1; finalVerse = 1; }
        else if (finalChapter && !finalVerse) { finalVerse = 1; }

        const ref = `${exactBook} ${finalChapter}:${finalVerse}`;
        return { book: exactBook, chapter: finalChapter, verse: finalVerse, rangeEnd: rangeEnd || null, reference: ref };
    }

    if (bestBook && bestScore >= 0.5) {
        return { didYouMean: bestBook, reference: buildRef(bestBook) };
    }

    return null;
}

window.findBibleVerseReference = findBibleVerseReference;
