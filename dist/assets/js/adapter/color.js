// Stable colors derived from ids: the id is hashed (FNV-1a) to a hue 0–359. The lightness is
// set by the CSS (.alias-color, .room-color), so every hue stays readable.
export function idHue(id) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        hash ^= id.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 360;
}
