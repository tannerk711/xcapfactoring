// Google Ads tag for the "XCap" account. The base tag renders in Base.astro on
// every page (library deferred until after first paint). The lead conversion
// fires from AuditFlow ONLY after /api/audit accepts the submit, never on page
// load or a raw button click, and is suppressed on localhost and ?qa=1.
// conversionLabel is the part after the slash in the conversion action's
// send_to value ("AW-18494627910/<label>"); this one is the account's
// "Submit lead form" action (id 7821106735, one per click). Empty = base tag
// only, no conversion event.
export const tracking = {
  googleAds: {
    tagId: 'AW-18494627910',
    conversionLabel: 'JWNTCK-8spEdEMbA9vJE',
  },
} as const;
