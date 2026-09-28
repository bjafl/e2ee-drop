// apps/api/src/lib/codewords.ts
//
// The derivation itself lives in packages/shared/src/codewords.ts so the web
// app can run the exact same code client-side (review finding F1 / the
// former "KNOWN LIMITATION" I5 note here): each party now derives the phrase
// from key material it holds itself, instead of displaying the `codewords`
// field this API returns. The server still computes and returns that field
// for backward compatibility, but no client comparison UI trusts it any more.
//
// Kept as a thin re-export (rather than importing @e2ee-drop/shared at every
// call site) so the API's call sites and lib/links.test.ts's vi.mock of this
// module keep working unchanged.
export { deriveCodewords, resolveLocale } from "@e2ee-drop/shared";
