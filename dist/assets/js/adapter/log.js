// Console logging with a scope prefix, e.g. "[ws] connected".
// debug() is only written when debugging is switched on in the browser console:
//   localStorage.setItem("ChatbitDebug", "1")   — and reload; removeItem(...) switches it off
//
// Never log message content, aliases, room names, keys, invite codes or whole objects from the
// database — the console can be read by anyone with access to the device. Ids only in debug().
const DEBUG_KEY = "ChatbitDebug";

function readDebug() {
    try {
        return localStorage.getItem(DEBUG_KEY) === "1";
    } catch {
        return false; // private mode
    }
}

const debugEnabled = readDebug();

export function logger(scope) {
    const prefix = `[${scope}]`;
    return {
        debug: (...args) => { if (debugEnabled) console.debug(prefix, ...args); },
        info:  (...args) => console.info(prefix, ...args),
        warn:  (...args) => console.warn(prefix, ...args),
        error: (...args) => console.error(prefix, ...args),
    };
}
