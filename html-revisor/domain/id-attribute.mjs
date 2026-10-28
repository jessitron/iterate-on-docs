// The attributes that carry element IDs in the file. Tier II. It imports nothing, so any
// module can name them; identity.mjs, which sits above scopes.mjs, holds what IDs do.
//
// An element ID lives in the file as data-hrv="<n>". The next unused number sits on
// <html data-hrv-next="<n>">, so an ID is never reused, even after its element is gone.
export const ID = 'data-hrv';
export const NEXT_ID = 'data-hrv-next';
