// apps/web/src/lib/storageProbe.ts
//
// Task 9 / review finding F9: `useLocalLinks.saveLink` looks synchronous (it's
// declared `async` and can be awaited) but its actual `localStorage.setItem`
// call happens later, decoupled, inside that hook's own `useEffect` — see
// useLocalLinks.ts. That effect wraps the write in a try/catch with no
// re-throw, so a caller can never observe a storage failure by awaiting
// `saveLink(...)`, no matter how the call is ordered around it.
//
// Anywhere a caller is about to take an action it cannot undo (the anonymous
// claim/create flows in ReceivePage.tsx and CreateLinkPage.tsx — there's no
// unclaim route, and an abandoned created link at least just expires) and
// that action's whole point is a key that only `saveLink` can make durable,
// probe storage directly first, so the user finds out *before* that
// irreversible step instead of after.
const PROBE_KEY = "e2ee-drop:storage-probe";

export function isLocalStorageWritable(): boolean {
  try {
    window.localStorage.setItem(PROBE_KEY, "1");
    const ok = window.localStorage.getItem(PROBE_KEY) === "1";
    window.localStorage.removeItem(PROBE_KEY);
    return ok;
  } catch {
    return false;
  }
}
