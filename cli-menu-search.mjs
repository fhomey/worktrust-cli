/**
 * SEARCH IN THE MENU (CLI 0.11.21; owner, 2026-11-22: "typing letters filters the list AND offers matches from all menus").
 * Pure, so the tests drive it without a terminal (scripts/lib/cli-menu-search-cases.mjs):
 *
 *   start     "/" starts a search; so does a letter that is not a key of its own (j and k move, q quits at the top)
 *   typing    every printable character adds to it (digits too, once searching); Backspace takes one back; Esc clears it
 *             and the list is whole again (Esc again is the usual back or quit)
 *   matches   the current list's rows whose label, command or sentence hold every word typed, then, under "In other menus",
 *             the rows of every other menu that do (searchIndex: what the menu loop registered), each with where it lives;
 *             Enter runs the chosen row as its own menu would (its own `run`: the same command)
 *   pickers   in a list that ticks with Space (the folders to add), the search filters that list only and Space still ticks:
 *             a row of another menu cannot be ticked into this one
 */
let index = () => [];
/** The menu loop's index of every menu's rows (cli-menu-remote.mjs menuIndex); each row may carry `where`. */
export const setSearchIndex = (fn) => { index = typeof fn === "function" ? fn : () => []; };
export const searchIndex = () => { try { return index() ?? []; } catch { return []; } };

const words = (query) => String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
export const rowMatches = (item, query) => { const text = `${item.label ?? ""} ${item.hint ?? ""} ${item.info ?? ""}`.toLowerCase(); const w = words(query); return w.length > 0 && w.every((x) => text.includes(x)); };
const keyOf = (item) => `${item.label}|${item.hint ?? ""}`;

/** The rows a list shows for `query` (null: not searching, the list as it is). */
export function searchItems(items, query, { multi = false, others = searchIndex } = {}) {
  if (query === null || query === undefined || words(query).length === 0) return items;
  const here = items.filter((item) => !item.back && !item.heading && rowMatches(item, query)), back = items.filter((item) => item.back);
  if (multi) return [...here, ...back];
  const seen = new Set(here.map(keyOf));
  const away = others().filter((item) => !item.back && !item.disabled && rowMatches(item, query) && !seen.has(keyOf(item))).slice(0, 8).map((item) => ({ ...item, note: item.where ? { text: item.where, tone: "dim" } : item.note }));
  const none = here.length + away.length === 0 ? [{ label: "No match", info: "Nothing matches. Esc clears the search.", disabled: true, quiet: "Nothing matches. Esc clears the search.", heading: true }] : [];
  return [...here, ...(away.length ? [{ label: "In other menus", info: "Rows of other menus that match.", disabled: true, quiet: "The rows below live in other menus.", heading: true }, ...away] : []), ...none, ...back];
}

/** One key. → { query, consumed }: `consumed` false leaves the key to the list (arrows, Enter, digits while not searching). */
export function searchKey(query, k, { multi = false, top = false } = {}) {
  const ch = typeof k?.str === "string" && k.str.length === 1 && !k.ctrl ? k.str : null;
  if (query === null || query === undefined) {
    if (ch === "/") return { query: "", consumed: true };
    if (ch && /^[a-z]$/i.test(ch) && !["j", "k"].includes(ch) && !(top && ch === "q")) return { query: ch, consumed: true };
    return { query: null, consumed: false };
  }
  if (k?.name === "escape") return { query: null, consumed: true };
  if (k?.name === "backspace") return { query: query.slice(0, -1), consumed: true };
  if (multi && k?.name === "space") return { query, consumed: false }; // Space still ticks in a picker
  if (ch && ch >= " " && ch !== "\x7f") return { query: query + ch, consumed: true };
  return { query, consumed: false };
}

/** The keys line while searching. */
export const searchFooter = (query) => `Search: ${query}_ · ↑/↓ move · Enter open · Backspace · Esc clear`;
